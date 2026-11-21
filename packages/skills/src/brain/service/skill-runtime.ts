import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  type CapabilityContext,
  detectRuntimeRequirements,
  RUNTIME_MANIFEST_MAX_BYTES,
  type SkillRuntimeRequirement,
} from "@pibot/brain/kit";
import { directoryIdentity, ExecError, SKILL_PYTHON_DOMAINS } from "@pibot/execution";
import { RpcError, RpcErrorCodes, type SkillRuntimeStatus } from "@pibot/skills-contract/full";
import { pythonPreparationCommand } from "./skill-runtime-command.ts";
import { runtimeOutputTail } from "./skill-runtime-log.ts";
import { ensurePrivateDir, SkillUv, SkillUvError, UV_VERSION } from "./skill-runtime-uv.ts";

/**
 * The skill's own virtual environment.
 *
 * Pi Bot does not run scripts shipped with the skill. Package builds can execute third-party
 * code; the local execution target confines writes and network access.
 */
export interface SkillRuntimeTarget {
  skillId: string;
  botId: string;
  name: string;
  /** Absolute folder that holds SKILL.md. */
  folder: string;
  groupId?: string;
}

export interface SkillRuntimeAudit {
  botId: string;
  skillId: string;
  skillName: string;
  runtime: "python" | "node";
  packages: number;
  result: "ready" | "failed" | "removed";
  reasonCode?: string;
}

export interface SkillRuntimeDeps {
  dataDir: string;
  platform: NodeJS.Platform;
  arch?: string;
  proxy?: CapabilityContext["local"]["deps"]["proxy"];
  redact?(text: string): string;
  local: Pick<CapabilityContext["local"], "target">;
  logger: Pick<CapabilityContext["logger"], "info" | "warn">;
  audit(input: SkillRuntimeAudit): void;
  emit?(target: SkillRuntimeTarget, status: SkillRuntimeStatus, progress: Active["progress"]): void;
}

interface EnvironmentState {
  version: 1;
  skillId: string;
  botId: string;
  runtime: "python" | "node";
  envId: string;
  status: "ready" | "failed";
  reason?: string;
  packages: number;
  interpreter: string;
  interpreterVersion: string;
  preparedAt: string;
  uvVersion?: string;
  groupId?: string;
}

interface Plan {
  runtime: "python" | "node";
  interpreter: string;
  interpreterVersion: string;
  packages: string[];
  pythonSpecs?: string[];
  envId: string;
  hash: string;
  steps: { phase: "create" | "dependencies" | "verify"; command: string }[];
}

type Phase = "create" | "dependencies" | "verify";

interface Active {
  abort: AbortController;
  done: Promise<void>;
  progress: { phase: Phase; done: number; total: number };
}

const STATE_FILE = "pibot-env.json";
const LOG_FILE = "prepare.log";
const MAX_LOG_BYTES = 4 * 1024 * 1024;
/** What a package manager needs: a registry and its file host, and nothing else. */
const NODE_DOMAINS = ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"];
const VERSION_CACHE_MS = 5 * 60_000;

function quote(value: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `"${value.replace(/"/g, '""')}"`
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Only the constraints skills actually use; an unparsable constraint never blocks a probe. */
function satisfies(found: string, constraint: string | undefined): boolean {
  if (!constraint) return true;
  const major = Number(found.split(".")[0] ?? 0);
  const minor = Number(found.split(".")[1] ?? 0);
  for (const part of constraint.split(",")) {
    const match = /^\s*(>=|<=|==|=|>|<|\^|~)?\s*(\d+)(?:\.(\d+))?/.exec(part.trim());
    if (!match) continue;
    const wanted = [Number(match[2]), Number(match[3] ?? 0)];
    const order = (wanted[0] ?? 0) - major || (wanted[1] ?? 0) - minor;
    switch (match[1] ?? "") {
      case ">=":
        if (order > 0) return false;
        break;
      case ">":
        if (order >= 0) return false;
        break;
      case "<=":
        if (order < 0) return false;
        break;
      case "<":
        if (order <= 0) return false;
        break;
      case "^":
      case "~":
        if (wanted[0] !== major) return false;
        break;
      default:
        if (order !== 0) return false;
    }
  }
  return true;
}

function pythonRequest(value: string | undefined): string | undefined {
  if (!value) return "3.12";
  const request = value.replace(/\s/g, "");
  if (
    request.length <= 100 &&
    /^(?:(?:~=|==|!=|>=|<=|>|<)\d+(?:\.\d+){0,2}(?:\.\*)?)(?:,(?:~=|==|!=|>=|<=|>|<)\d+(?:\.\d+){0,2}(?:\.\*)?)*$/.test(
      request,
    )
  )
    return request;
}

/** Only package names/extras with version constraints and optional environment markers. */
function indexRequirement(spec: string): boolean {
  const [requirement, ...marker] = spec.split(";");
  return (
    /^[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9._, -]+\])?(?:\s*(?:===|~=|==|!=|<=|>=|<|>)\s*[a-z0-9.*!+_-]+(?:\s*,\s*(?:===|~=|==|!=|<=|>=|<|>)\s*[a-z0-9.*!+_-]+)*)?\s*$/i.test(
      requirement ?? "",
    ) &&
    marker.length <= 1 &&
    marker.every((part) => /^[a-z0-9.\s_'"()<>=!+-]+$/i.test(part)) &&
    !/[\r\n]/.test(spec)
  );
}

function below(root: string, path: string) {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class SkillRuntimeService {
  private readonly uv: SkillUv;
  private readonly active = new Map<string, Active>();
  private readonly removing = new Set<string>();
  private readonly versions = new Map<
    string,
    { at: number; value?: { command: string; version: string } }
  >();

  constructor(private readonly deps: SkillRuntimeDeps) {
    this.uv = new SkillUv(deps.dataDir, deps.platform, deps.arch ?? process.arch, deps.proxy);
  }

  private root(): string {
    return join(this.deps.dataDir, "skill-envs");
  }

  private envDir(envId: string): string {
    return join(this.root(), envId);
  }

  private binDir(envId: string): string {
    return join(this.envDir(envId), this.deps.platform === "win32" ? "Scripts" : "bin");
  }

  private async readText(folder: string, name: string): Promise<string | undefined> {
    try {
      const info = await lstat(join(folder, name));
      // A manifest above the bound is treated as absent: it never becomes a read of arbitrary size.
      if (!info.isFile() || info.size > RUNTIME_MANIFEST_MAX_BYTES) return undefined;
      return await readFile(join(folder, name), "utf8");
    } catch {
      return undefined;
    }
  }

  /** Direct sub-folders that can hold a skill's own manifest; environments and caches are not. */
  private async subfolders(folder: string): Promise<string[]> {
    try {
      return (await readdir(folder, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            !["node_modules", "venv", "site-packages", "__pycache__"].includes(entry.name),
        )
        .map((entry) => entry.name)
        .sort()
        .slice(0, 100);
    } catch {
      // An unreadable folder has no manifest to offer; detection then sees only the root.
      return [];
    }
  }

  private async detect(target: SkillRuntimeTarget): Promise<{
    requirements: SkillRuntimeRequirement[];
    native: string[];
    specs: string[];
  }> {
    const present: string[] = [];
    for (const name of ["requirements.txt", "pyproject.toml", "package.json"])
      if ((await this.readText(target.folder, name)) !== undefined) present.push(name);
    // The import preview also reads a requirements.txt one folder down (`scripts/requirements.txt`
    // is common); without the same look here the card promised Python packages that were never
    // planned, and the saved skill reported "no runtime needed".
    if (!present.includes("requirements.txt"))
      for (const folder of await this.subfolders(target.folder)) {
        const path = `${folder}/requirements.txt`;
        if ((await this.readText(target.folder, path)) !== undefined) present.push(path);
      }
    const cache = new Map<string, string | undefined>();
    const detection = await detectRuntimeRequirements(present, async (path) => {
      if (!cache.has(path)) cache.set(path, await this.readText(target.folder, path));
      return cache.get(path);
    });
    return {
      requirements: detection.requirements,
      native: detection.native,
      specs: detection.pythonSpecs,
    };
  }

  private async probe(
    target: SkillRuntimeTarget,
  ): Promise<{ command: string; version: string } | undefined> {
    const key = target.botId;
    const cached = this.versions.get(key);
    if (cached && Date.now() - cached.at < VERSION_CACHE_MS) return cached.value;
    const candidates = [{ command: "node", args: [] as string[] }];
    let found: { command: string; version: string } | undefined;
    for (const candidate of candidates) {
      const dir = join(this.root(), `.probe-${randomUUID()}`);
      const file = join(dir, "version.txt");
      const command = [candidate.command, ...candidate.args]
        .map((value) => quote(value, this.deps.platform))
        .join(" ");
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const result = await this.deps.local.target.runCommand({
          command: `${command} --version > ${quote(file, this.deps.platform)} 2>&1`,
          cwd: dir,
          dataDir: this.deps.dataDir,
          botHome: join(this.deps.dataDir, "bots", target.botId, "home"),
          skillGroupId: target.groupId,
          writeRoots: [dir],
          network: { allowAll: false, domains: [] },
          runId: `skill-probe-${randomUUID()}`,
          // A missing interpreter must fail fast; a probe that hangs would block the detail view.
          signal: AbortSignal.timeout(30_000),
        });
        const version = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(
          await readFile(file, "utf8").catch(() => ""),
        );
        if (result.exitCode === 0 && version) {
          found = {
            command: [candidate.command, ...candidate.args].join(" "),
            version: `${version[1]}.${version[2]}${version[3] ? `.${version[3]}` : ""}`,
          };
          break;
        }
      } catch (error) {
        this.deps.logger.warn(
          JSON.stringify({
            module: "skills",
            event: "runtime_probe_failed",
            runtime: "node",
            command: candidate.command,
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    this.versions.set(key, { at: Date.now(), value: found });
    return found;
  }

  private async usablePython(envId: string): Promise<boolean> {
    try {
      const env = this.venvDir(envId);
      if (!(await lstat(env)).isDirectory()) return false;
      const data = await realpath(this.deps.dataDir);
      const managed = join(data, "runtimes", "python");
      const file = await realpath(this.pythonPath(envId));
      return (
        (below(join(data, "skill-envs", envId, "venv"), file) || below(managed, file)) &&
        (await lstat(file)).isFile()
      );
    } catch {
      return false;
    }
  }

  private async readState(envId: string): Promise<EnvironmentState | undefined> {
    try {
      const dir = this.envDir(envId);
      if (!(await lstat(dir)).isDirectory()) return undefined;
      const path = join(dir, STATE_FILE);
      const info = await lstat(path);
      if (!info.isFile() || info.size > 8192) return undefined;
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      const state = value as EnvironmentState;
      return state && state.version === 1 && state.envId === envId ? state : undefined;
    } catch {
      return undefined;
    }
  }

  private async states(skillId: string): Promise<EnvironmentState[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root());
    } catch {
      return [];
    }
    const states: EnvironmentState[] = [];
    for (const name of entries) {
      if (!/^[a-f0-9]{16}$/.test(name)) continue;
      const state = await this.readState(name);
      if (state?.skillId === skillId) states.push(state);
    }
    return states;
  }

  private async plan(
    target: SkillRuntimeTarget,
  ): Promise<{ plan: Plan | null; status: SkillRuntimeStatus }> {
    const detected = await this.detect(target);
    const base: SkillRuntimeStatus = {
      skillId: target.skillId,
      state: "not_required",
      requirements: detected.requirements,
      nativeModules: detected.native,
      interpreter: null,
      envId: null,
      planHash: null,
      packages: 0,
      bytes: null,
      reason: null,
      logPath: null,
      progress: null,
    };
    const requirement = detected.requirements[0];
    if (!requirement) return { plan: null, status: base };
    const runtime = requirement.runtime;
    if (runtime === "python") return this.planPython(target, base, requirement, detected.specs);
    const found = await this.probe(target);
    const envId = createHash("sha256")
      .update(
        [
          "v1",
          this.deps.platform,
          runtime,
          found?.version ?? "none",
          requirement.version ?? "",
          JSON.stringify(requirement.packages ?? []),
          JSON.stringify(detected.specs),
        ].join("\n"),
      )
      .digest("hex")
      .slice(0, 16);
    if (!found)
      return {
        plan: null,
        status: { ...base, state: "failed", envId, reason: `${runtime}_not_found` },
      };
    const interpreter = { command: found.command, version: found.version };
    if (!satisfies(found.version, requirement.version))
      return {
        plan: null,
        status: {
          ...base,
          state: "failed",
          envId,
          interpreter,
          reason: `${runtime}_version_unsatisfied`,
        },
      };
    const npm = this.deps.platform === "win32" ? "npm.cmd" : "npm";
    const steps: Plan["steps"] = [
      { phase: "create", command: `${npm} ci --ignore-scripts` },
      { phase: "dependencies", command: `${npm} install --ignore-scripts --no-audit --no-fund` },
      { phase: "verify", command: `${npm} --version` },
    ];
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          envId,
          interpreter,
          steps: steps.map((step) => step.command),
          domains: NODE_DOMAINS,
        }),
      )
      .digest("hex");
    return {
      plan: {
        runtime,
        interpreter: found.command,
        interpreterVersion: found.version,
        packages: requirement.packages ?? [],
        envId,
        hash,
        steps,
      },
      status: {
        ...base,
        state: "not_prepared",
        envId,
        planHash: hash,
        interpreter,
        packages: requirement.packages?.length ?? 0,
      },
    };
  }

  private planPython(
    target: SkillRuntimeTarget,
    base: SkillRuntimeStatus,
    requirement: SkillRuntimeRequirement,
    specs: string[],
  ): { plan: Plan | null; status: SkillRuntimeStatus } {
    const release = this.uv.release;
    if (!release)
      return {
        plan: null,
        status: { ...base, state: "failed", reason: "uv_unsupported_platform" },
      };
    const request = pythonRequest(requirement.version);
    if (!request || !specs.every(indexRequirement))
      return {
        plan: null,
        status: { ...base, state: "failed", reason: "python_requirement_unsupported" },
      };
    const envId = digest([
      "managed-python-v1",
      target.botId,
      target.groupId,
      target.skillId,
      release.target,
      UV_VERSION,
      request,
      specs,
    ]).slice(0, 16);
    const dir = this.venvDir(envId);
    const windows = this.deps.platform === "win32";
    const q = (value: string) =>
      windows ? `'${value.replaceAll("'", "''")}'` : quote(value, this.deps.platform);
    const invoke = windows ? "& " : "";
    const uv = `${invoke}${q(this.uv.path)}`;
    const python = q(this.pythonPath(envId));
    const steps: Plan["steps"] = [
      { phase: "create", command: `${uv} venv --no-project --python ${q(request)} ${q(dir)}` },
      ...(specs.length
        ? [
            {
              phase: "dependencies" as const,
              // Wheels only: without this uv builds sdists (PyMuPDF on Intel Macs), which needs a compiler
              // ordinary users don't have; uv instead picks the newest version that ships a wheel.
              command: `${uv} pip install --no-cache --only-binary :all: --link-mode copy --python ${python} -r ${q(join(dir, "requirements.txt"))}`,
            },
          ]
        : []),
      { phase: "verify", command: `${invoke}${python} --version` },
    ];
    const packages = requirement.packages ?? [];
    const managedPython = { uvVersion: UV_VERSION, uvBytes: release.bytes, pythonRequest: request };
    const hash = digest({ envId, steps, packages, managedPython, domains: SKILL_PYTHON_DOMAINS });
    return {
      plan: {
        runtime: "python",
        interpreter: "Python",
        interpreterVersion: request,
        pythonSpecs: specs,
        packages,
        envId,
        hash,
        steps,
      },
      status: {
        ...base,
        state: "not_prepared",
        envId,
        planHash: hash,
        packages: packages.length,
        managedPython,
      },
    };
  }

  private venvDir(envId: string): string {
    return join(this.envDir(envId), "venv");
  }

  private pythonPath(envId: string): string {
    return join(
      this.venvDir(envId),
      this.deps.platform === "win32" ? "Scripts" : "bin",
      this.deps.platform === "win32" ? "python.exe" : "python",
    );
  }

  private async size(folder: string, signal?: AbortSignal): Promise<number | null> {
    let total = 0;
    const walk = async (path: string): Promise<void> => {
      signal?.throwIfAborted();
      for (const entry of await readdir(path, { withFileTypes: true })) {
        signal?.throwIfAborted();
        const child = join(path, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) total += (await stat(child)).size;
      }
    };
    try {
      await walk(folder);
      return total;
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }

  async status(target: SkillRuntimeTarget, signal?: AbortSignal): Promise<SkillRuntimeStatus> {
    signal?.throwIfAborted();
    const { plan, status } = await this.plan(target);
    signal?.throwIfAborted();
    if (!plan) return status;
    const running = this.active.get(target.skillId);
    if (running)
      return {
        ...status,
        state: "preparing",
        logPath: join(this.envDir(plan.envId), LOG_FILE),
        progress: { ...running.progress },
      };
    const current = await this.readState(plan.envId);
    if (
      current?.status === "ready" &&
      (plan.runtime === "node" ||
        (current.uvVersion === UV_VERSION && (await this.usablePython(plan.envId))))
    )
      return {
        ...status,
        state: "ready",
        bytes: await this.size(this.envDir(plan.envId), signal),
        interpreter: { command: current.interpreter, version: current.interpreterVersion },
      };
    if (current?.status === "ready") return { ...status, state: "needs_prepare" };
    if (current)
      return {
        ...status,
        state: "failed",
        reason: current.reason ?? "install_failed",
        logPath: join(this.envDir(plan.envId), LOG_FILE),
      };
    // An environment built for another interpreter or manifest set cannot be reused; saying
    // "ready" would hide that it has to be prepared again.
    const previous = (await this.states(target.skillId)).some((state) => state.status === "ready");
    return previous ? { ...status, state: "needs_prepare" } : status;
  }

  private async append(file: string, text: string): Promise<void> {
    const handle = await open(file, "a", 0o600);
    try {
      const info = await handle.stat();
      if (info.size < MAX_LOG_BYTES)
        await handle.writeFile(Buffer.from(text).subarray(0, MAX_LOG_BYTES - info.size));
    } finally {
      await handle.close();
    }
  }

  async prepare(
    target: SkillRuntimeTarget,
    planHash: string,
    signal: AbortSignal,
  ): Promise<SkillRuntimeStatus> {
    if (this.active.has(target.skillId) || this.removing.has(target.skillId))
      return this.status(target);
    signal.throwIfAborted();
    const { plan, status } = await this.plan(target);
    if (!plan) return status;
    if (plan.hash !== planHash)
      throw new RpcError(RpcErrorCodes.invalidParams, "skill_runtime_plan_changed");
    if (
      (await this.readState(plan.envId))?.status === "ready" &&
      (plan.runtime === "node" || (await this.usablePython(plan.envId)))
    )
      return this.status(target);
    if (this.active.has(target.skillId) || this.removing.has(target.skillId))
      return this.status(target);
    signal.throwIfAborted();
    const abort = new AbortController();
    const active: Active = {
      abort,
      progress: { phase: "create", done: 0, total: plan.steps.length },
      done: Promise.resolve(),
    };
    this.active.set(target.skillId, active);
    active.done = this.runPlan(
      target,
      plan,
      status,
      active,
      AbortSignal.any([signal, abort.signal]),
    ).finally(() => {
      this.active.delete(target.skillId);
    });
    await active.done;
    const final = await this.status(target);
    this.deps.emit?.(target, final, active.progress);
    return final;
  }

  private async runPlan(
    target: SkillRuntimeTarget,
    plan: Plan,
    status: SkillRuntimeStatus,
    active: Active,
    signal: AbortSignal,
  ): Promise<void> {
    const metadata = this.envDir(plan.envId);
    const log = join(metadata, LOG_FILE);
    const python = plan.runtime === "python";
    const dir = python ? this.venvDir(plan.envId) : metadata;
    let created = false;
    let dispatched = false;
    let reason: string | undefined;
    // Read in the catch below to name the phase that hit the workspace boundary.
    let currentPhase: Plan["steps"][number]["phase"] | undefined;
    try {
      signal.throwIfAborted();
      if (python) {
        const previous = await this.readState(plan.envId);
        if (previous?.reason === "uv_cleanup_unconfirmed")
          await this.deps.local.target.isolationStatus(signal);
        await ensurePrivateDir(this.root());
        // A failed or interrupted build must never be the starting point for another install.
        await rm(metadata, { recursive: true, force: true });
        await ensurePrivateDir(metadata);
        await ensurePrivateDir(dir);
        created = true;
        this.deps.emit?.(target, { ...status, state: "preparing" }, active.progress);
        if (!(await this.deps.local.target.isolationStatus(signal)).available)
          throw new ExecError("isolation_unavailable");
        await this.uv.ensure(signal);
        await ensurePrivateDir(join(this.deps.dataDir, "runtimes", "python"));
        await ensurePrivateDir(join(this.deps.dataDir, "runtimes"));
        await ensurePrivateDir(join(this.deps.dataDir, "runtimes", "uv-cache"));
      } else {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await this.copyNodeManifest(target, dir);
      }
      await this.append(
        log,
        `# ${new Date().toISOString()} ${plan.runtime} ${plan.interpreterVersion}\n`,
      );
      for (const [index, step] of plan.steps.entries()) {
        signal.throwIfAborted();
        currentPhase = step.phase;
        active.progress = { phase: step.phase, done: index, total: plan.steps.length };
        this.deps.emit?.(target, { ...status, state: "preparing" }, active.progress);
        if (python && step.phase === "dependencies") await this.writeRequirements(plan, dir);
        const dataDir = this.deps.dataDir;
        if (python && step.phase !== "create" && !(await this.usablePython(plan.envId)))
          throw new Error("install_failed");
        let output = "";
        const preparation = python
          ? { envId: plan.envId, uvVersion: UV_VERSION, phase: step.phase }
          : undefined;
        dispatched = true;
        const result = await this.deps.local.target
          .runCommand({
            ...(preparation
              ? await pythonPreparationCommand({
                  dataDir,
                  target,
                  preparation,
                  command: step.command,
                  signal,
                })
              : {
                  command: step.command,
                  cwd: dir,
                  rootIdentities: [await directoryIdentity(dir)],
                  dataDir,
                  botHome: join(dataDir, "bots", target.botId, "home"),
                  skillGroupId: target.groupId,
                  writeRoots: [dir],
                  network: { allowAll: false, domains: NODE_DOMAINS },
                  pathEntries: [this.binDir(plan.envId)],
                  runId: `skill-env-${randomUUID()}`,
                  signal,
                }),
            onOutput: python
              ? (text) => {
                  output = (output + text).slice(-32 * 1024);
                }
              : undefined,
          })
          .catch(async (error: unknown) => {
            if (python) {
              try {
                const code = error instanceof ExecError ? error.code : "command_failed";
                const detail = error instanceof ExecError ? error.reason : undefined;
                const root = error instanceof ExecError ? error.profileWriteRoot : undefined;
                await this.append(
                  log,
                  `${step.phase}: failed error=${code}${detail ? ` reason=${detail}` : ""}${root ? ` root_index=${root.index} root_kind=${root.kind}` : ""}\n`,
                );
                const tail = runtimeOutputTail(
                  output,
                  { dataDir, venv: dir, skill: target.folder },
                  this.deps.redact,
                );
                await this.append(log, `${tail || "[no stdout/stderr received]"}\n`);
              } catch {
                // A full disk must not hide cleanup_failed and cause removal of a live venv.
                this.deps.logger.warn(
                  JSON.stringify({
                    module: "skills",
                    event: "runtime_diagnostic_write_failed",
                    botId: target.botId,
                    skillId: target.skillId,
                    phase: step.phase,
                  }),
                );
              }
            }
            throw error;
          });
        if (!python) signal.throwIfAborted();
        if (python) {
          await this.append(
            log,
            `${step.phase}: ${result.exitCode === 0 ? "ok" : "failed"} exit=${result.exitCode ?? "null"} timed_out=${result.timedOut} stopped=${result.stopped}\n`,
          );
          const tail = runtimeOutputTail(
            result.truncatedOutput || output,
            { dataDir, venv: dir, skill: target.folder },
            this.deps.redact,
          );
          await this.append(log, `${tail || "[no stdout/stderr received]"}\n`);
        } else {
          const text = await readFile(result.logPath, "utf8").catch(() => "");
          await this.append(log, `$ ${step.command}\n${this.deps.redact?.(text) ?? text}\n`);
        }
        signal.throwIfAborted();
        if (result.exitCode !== 0) throw new Error("install_failed");
        if (python && step.phase === "verify") {
          const version = /(?:^|\n)Python (\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?)\s*(?:$|\n)/.exec(
            output,
          )?.[1];
          if (!version || !(await this.usablePython(plan.envId))) throw new Error("install_failed");
          plan.interpreterVersion = version;
        }
      }
      await this.saveState(plan, target, { status: "ready" });
    } catch (error) {
      const cleanupUnconfirmed = error instanceof ExecError && error.reason === "cleanup_failed";
      reason = cleanupUnconfirmed
        ? "uv_cleanup_unconfirmed"
        : signal.aborted
          ? "cancelled"
          : error instanceof SkillUvError
            ? error.reason
            : error instanceof ExecError && error.code === "isolation_unavailable"
              ? "uv_isolation_unavailable"
              : error instanceof ExecError && error.code === "outside_workplace"
                ? "python_workspace_boundary"
                : python && !dispatched
                  ? "uv_download_failed"
                  : "install_failed";
      // Execution may be retaining a tree whose teardown could not be confirmed. Do not remove
      // its working directory in that case; the failed state keeps it out of runtime selection.
      if (python && created && !cleanupUnconfirmed) {
        await rm(dir, { recursive: true, force: true });
        await ensurePrivateDir(dir);
        await this.append(
          log,
          reason === "python_workspace_boundary"
            ? `failed: ${reason} (${currentPhase ?? "preparation"}; ${
                error instanceof ExecError && error.reason?.startsWith("profile_")
                  ? error.reason
                  : "managed runtime root"
              })\n`
            : `failed: ${reason}\n`,
        );
      }
      if (!python || created) await this.saveState(plan, target, { status: "failed", reason });
    }
    this.deps.audit({
      botId: target.botId,
      skillId: target.skillId,
      skillName: target.name,
      runtime: plan.runtime,
      packages: plan.packages.length,
      result: reason ? "failed" : "ready",
      reasonCode: reason,
    });
  }

  private async writeRequirements(plan: Plan, dir: string): Promise<void> {
    const handle = await open(join(dir, "requirements.txt"), "wx", 0o600);
    try {
      await handle.writeFile(`${(plan.pythonSpecs ?? []).join("\n")}\n`);
    } finally {
      await handle.close();
    }
  }

  private async copyNodeManifest(target: SkillRuntimeTarget, dir: string): Promise<void> {
    for (const name of ["package.json", "package-lock.json"]) {
      const text = await this.readText(target.folder, name);
      if (text === undefined) continue;
      const handle = await open(join(dir, name), "w", 0o600);
      try {
        await handle.writeFile(text);
      } finally {
        await handle.close();
      }
    }
  }

  private async saveState(
    plan: Plan,
    target: SkillRuntimeTarget,
    value: { status: "ready" | "failed"; reason?: string },
  ): Promise<void> {
    const state: EnvironmentState = {
      version: 1,
      skillId: target.skillId,
      botId: target.botId,
      runtime: plan.runtime,
      envId: plan.envId,
      status: value.status,
      ...(value.reason ? { reason: value.reason } : {}),
      packages: plan.packages.length,
      interpreter: plan.interpreter,
      interpreterVersion: plan.interpreterVersion,
      preparedAt: new Date().toISOString(),
      ...(plan.runtime === "python" ? { uvVersion: UV_VERSION, groupId: target.groupId } : {}),
    };
    const dir = this.envDir(plan.envId);
    const temp = join(dir, `.${randomUUID()}.json`);
    const handle = await open(temp, "wx", 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(state));
      } finally {
        await handle.close();
      }
      await rename(temp, join(dir, STATE_FILE));
    } finally {
      await rm(temp, { force: true });
    }
  }

  /**
   * The environment a bot's commands inherit. A bot usually has one skill with a runtime,
   * so the lowest env id wins and the injected variables stay identical across turns.
   */
  async environment(
    botId: string,
    effectiveTarget?: (skillId: string) => SkillRuntimeTarget | undefined,
  ): Promise<{ id: string; dir: string; bin: string; python?: string; node?: string } | undefined> {
    let entries: string[];
    try {
      entries = await readdir(this.root());
    } catch {
      return undefined;
    }
    for (const id of entries.filter((name) => /^[a-f0-9]{16}$/.test(name)).sort()) {
      const state = await this.readState(id);
      if (!state || state.botId !== botId || state.status !== "ready") continue;
      if (state.runtime === "python") {
        const target = effectiveTarget?.(state.skillId);
        if (
          !target ||
          state.uvVersion !== UV_VERSION ||
          target.groupId !== state.groupId ||
          (await this.plan(target)).plan?.envId !== id ||
          !(await this.usablePython(id))
        )
          continue;
      }
      const dir = this.envDir(id);
      if (state.runtime === "node")
        return { id, dir, bin: "node_modules/.bin", node: state.interpreter };
      return {
        id,
        dir,
        bin: this.deps.platform === "win32" ? "venv/Scripts" : "venv/bin",
        python: this.pythonPath(id),
      };
    }
    return undefined;
  }

  async cancel(target: SkillRuntimeTarget): Promise<SkillRuntimeStatus> {
    const active = this.active.get(target.skillId);
    active?.abort.abort();
    await active?.done;
    return this.status(target);
  }

  async remove(target: SkillRuntimeTarget): Promise<SkillRuntimeStatus> {
    if (this.removing.has(target.skillId)) return this.status(target);
    this.removing.add(target.skillId);
    try {
      await this.cancel(target);
      for (const state of await this.states(target.skillId)) {
        if (state.botId !== target.botId || (state.uvVersion && state.groupId !== target.groupId))
          continue;
        if (state.reason === "uv_cleanup_unconfirmed")
          await this.deps.local.target.isolationStatus();
        await rm(this.envDir(state.envId), { recursive: true, force: true });
        this.deps.audit({
          botId: target.botId,
          skillId: target.skillId,
          skillName: target.name,
          runtime: state.runtime,
          packages: state.packages,
          result: "removed",
        });
      }
    } finally {
      this.removing.delete(target.skillId);
    }
    return this.status(target);
  }

  async log(target: SkillRuntimeTarget): Promise<{ path: string | null; text: string }> {
    const status = await this.status(target);
    if (!status.envId) return { path: null, text: "" };
    const path = join(this.envDir(status.envId), LOG_FILE);
    try {
      const info = await stat(path);
      const length = Math.min(info.size, 200_000);
      const buffer = Buffer.alloc(length);
      const handle = await open(path, "r");
      try {
        await handle.read(buffer, 0, length, Math.max(0, info.size - length));
      } finally {
        await handle.close();
      }
      return { path, text: buffer.toString("utf8") };
    } catch {
      return { path, text: "" };
    }
  }

  /** Environments a Bot can use right now; `run_command` picks the one the command belongs to. */
  async readyEnvironments(
    botId: string,
  ): Promise<{ envId: string; skillId: string; dir: string; python?: string; node?: string }[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root());
    } catch {
      return [];
    }
    const ready: { envId: string; skillId: string; dir: string; python?: string; node?: string }[] =
      [];
    for (const name of entries) {
      if (!/^[a-f0-9]{16}$/.test(name)) continue;
      const state = await this.readState(name);
      if (state?.status !== "ready" || state.botId !== botId) continue;
      if (
        state.runtime === "python" &&
        (state.uvVersion !== UV_VERSION || !(await this.usablePython(name)))
      )
        continue;
      const bin = this.binDir(name);
      ready.push({
        envId: name,
        skillId: state.skillId,
        dir: this.envDir(name),
        ...(state.runtime === "python"
          ? { python: this.pythonPath(name) }
          : { node: join(bin, this.deps.platform === "win32" ? "node.exe" : "node") }),
      });
    }
    return ready;
  }
}
