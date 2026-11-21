import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  BackgroundStartOptions,
  CommandDiagnostic,
  ExecOptions,
  RunCommandOptions,
} from "../core/types.ts";
import { ExecError } from "../core/types.ts";
import { dockerArguments, verifyDockerConnection } from "../docker/docker.ts";
import { dockerProgram } from "../docker/docker-program.ts";
import type { createSandboxProfiles } from "../sandbox/sandbox-profiles.ts";
import type { NetworkProxy } from "../web/network-proxy.ts";
import type { BackgroundProcessRecord, createBackgroundJobs } from "./background.ts";
import type { createCommandTemps } from "./command-temp.ts";
import { commandEnvironment, userTerminalEnvironment } from "./environment.ts";
import { preparePackageManagerEnvironment } from "./package-manager-environment.ts";
import { mergeSecretEnv } from "./secret-env.ts";
import { SKILL_PYTHON_DOMAINS, skillPythonPaths, skillPythonWriteRoots } from "./skill-python.ts";

export interface CommandDependencies {
  options: ExecOptions;
  sandbox: ReturnType<typeof createSandboxProfiles>;
  temps: ReturnType<typeof createCommandTemps>;
  /** The sandbox's own denial reports, per command (macOS; others report nothing). */
  violations: import("../sandbox/violation-monitor.ts").ViolationMonitor;
  background: ReturnType<typeof createBackgroundJobs>;
  lifetime: AbortController;
  /** `record` carries the failed foreground command's own tree when no job is involved. */
  failDrain(error: ExecError, jobId?: string, record?: BackgroundProcessRecord): void;
  drainFailed(): boolean;
  retainCommand(work: Promise<unknown>, runId: string): void;
  adoptForeground(job: import("./background.ts").BackgroundJob): void;
}
export interface CommandStage {
  stage: CommandDiagnostic["stage"];
}
type Input = RunCommandOptions | BackgroundStartOptions;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function invalidBoundary(input: Input, id: string) {
  return (
    !input.command ||
    input.command.includes("\0") ||
    !UUID.test(id) ||
    !isAbsolute(input.cwd) ||
    !isAbsolute(input.dataDir) ||
    !isAbsolute(input.botHome) ||
    (input.skillGroupId !== undefined && !UUID.test(input.skillGroupId)) ||
    (input.homeDir !== undefined && !isAbsolute(input.homeDir)) ||
    input.writeRoots.some((root) => !isAbsolute(root)) ||
    input.denyWriteRoots?.some((root) => !isAbsolute(root))
  );
}
export async function commandIsolation(
  deps: CommandDependencies,
  input: Input,
  signal: AbortSignal,
  state: CommandStage,
) {
  const { options, sandbox } = deps;
  if (input.skillPythonPreparation) {
    const paths = skillPythonPaths(input.dataDir, input.skillPythonPreparation);
    const expected = skillPythonWriteRoots(paths, input.skillPythonPreparation.phase);
    if (
      input.docker ||
      input.allowUnisolated ||
      input.outsideSandbox ||
      input.promotion ||
      input.gitHook ||
      input.gitOutput ||
      input.hostSsh ||
      input.skillEnv ||
      input.secretEnv ||
      input.cwd !== paths.env ||
      input.writeRoots.length !== expected.length ||
      !expected.every((path) => input.writeRoots.includes(path)) ||
      input.network.allowAll ||
      input.network.domains.length !== SKILL_PYTHON_DOMAINS.length ||
      !SKILL_PYTHON_DOMAINS.every((host) => input.network.domains.includes(host))
    )
      throw new ExecError("invalid_input");
  }

  if (
    (input.denyWriteRoots?.length || input.rootIdentities?.some((r) => r.role === "readonly")) &&
    (options.platform !== "darwin" || input.docker)
  )
    throw new ExecError("isolation_unavailable");
  state.stage = "isolation";
  const isolation = await sandbox.isolationStatus(signal);
  signal.throwIfAborted();
  if (
    !input.docker &&
    !isolation.available &&
    (isolation.reason !== "windows_unisolated" ||
      !input.allowUnisolated ||
      !input.network.allowAll ||
      input.denyWriteRoots?.length ||
      input.rootIdentities?.some((r) => r.role === "readonly"))
  )
    throw new ExecError("isolation_unavailable");
  // An unisolated command sees Pi Bot's proxy only through environment variables, and a proxy's
  // username and password never go into a command's environment.
  if (!input.docker && !isolation.available && proxyCredentials(options.proxy?.()))
    throw new ExecError("isolation_unavailable", "windows_proxy_credentials");
  if (input.docker) {
    if ((options.platform === "darwin" && !isolation.available) || !input.assertDockerAuthorized)
      throw new ExecError("docker_unsupported");
    input.assertDockerAuthorized();
    await verifyDockerConnection(options.platform, options.systemHome, input.docker);
  }
  return isolation;
}
export async function commandResources(
  deps: CommandDependencies,
  input: Input,
  temp: string,
  signal: AbortSignal,
) {
  const { options } = deps;
  const cwd = await realpath(input.cwd),
    home = await realpath(input.botHome);
  if (input.homeDir && (await realpath(input.homeDir)) !== home)
    throw new ExecError("invalid_input");
  // Only an issued permit leads to an unsandboxed spawn (command-run consumes it first).
  const outside = "outsideSandbox" in input && input.outsideSandbox !== undefined;
  const env = mergeSecretEnv(
    outside
      ? userTerminalEnvironment(
          options.platform,
          options.env,
          options.systemHome,
          temp,
          input.pathEntries,
        )
      : commandEnvironment(options.platform, options.env, home, temp, input.pathEntries),
    input.secretEnv,
  );
  // A skill runtime lives outside the workplace, so these variables are the only way a
  // skill script finds its own interpreter; PATH keeps the environment's entry points first so a
  // plain `python` inside the skill folder resolves to the prepared venv.
  if (input.skillEnv) {
    const { dir, bin, python, node } = input.skillEnv;
    env.PIBOT_SKILL_DIR = dir;
    if (python) env.PIBOT_SKILL_PYTHON = python;
    if (node) env.PIBOT_SKILL_NODE = node;
    const prefix = join(dir, ...bin.split("/"));
    env.PATH = [prefix, env.PATH]
      .filter((part) => part !== undefined && part !== "")
      .join(options.platform === "win32" ? ";" : ":");
  }
  // Maintainers 2026-11-19: Windows commands run unisolated, so Pi Bot's proxy reaches them through
  // the variables tools read instead of the sandbox's network host. Local addresses stay direct.
  if (options.platform === "win32" && !input.docker)
    windowsProxyEnvironment(env, options.proxy?.());
  await preparePackageManagerEnvironment(
    options.platform,
    env,
    cwd,
    temp,
    signal,
    input.writeRoots,
    options.systemHome,
    !outside,
  );
  if (input.skillPythonPreparation) {
    const paths = skillPythonPaths(input.dataDir, input.skillPythonPreparation);
    Object.assign(env, {
      UV_PYTHON_PREFERENCE: "only-managed",
      UV_PYTHON_INSTALL_DIR: paths.python,
      UV_CACHE_DIR: paths.cache,
      UV_NO_CONFIG: "1",
      UV_NO_PROGRESS: "1",
    });
  }
  return { cwd, home, temp, env };
}
export type CommandResources = Awaited<ReturnType<typeof commandResources>>;
export async function dockerResources(
  deps: CommandDependencies,
  input: RunCommandOptions,
  resources: CommandResources,
  signal: AbortSignal,
) {
  if (!input.docker) return undefined;
  const { options } = deps;
  const { env, temp } = resources;
  env.DOCKER_CONFIG = await mkdtemp(join(temp, "docker-config-"));
  env.DOCKER_HOST = input.docker.endpoint;
  const plugins = [join(options.systemHome, ".docker", "cli-plugins")];
  if (options.platform === "darwin")
    plugins.push(
      "/Applications/Docker.app/Contents/Resources/cli-plugins",
      "/Applications/OrbStack.app/Contents/MacOS/xbin",
    );
  await writeFile(
    join(env.DOCKER_CONFIG, "config.json"),
    JSON.stringify({ cliPluginsExtraDirs: plugins }),
    { flag: "wx", mode: 0o600 },
  );
  const args = dockerArguments(input.command, options.platform);
  const program = await dockerProgram(
    options.platform,
    options.env,
    [...input.writeRoots, temp],
    signal,
  );
  return { program, args };
}
export async function commandLog(home: string, directory: "runs" | "background", id: string) {
  const root = join(home, ".pibot", directory);
  for (const path of [join(home, ".pibot"), root]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await realpath(path)) !== resolve(path))
      throw new ExecError("outside_workplace", "workspace_root_alias");
  }
  return join(root, `${id}.log`);
}
export function openCommandLog(path: string) {
  return open(
    path,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
}
export const tempCommand = (command: string, temp: string) =>
  `export TMPDIR='${temp.replaceAll("'", "'\\''")}'\n${command}`;

function proxyCredentials(proxy: NetworkProxy | undefined) {
  if (!proxy) return false;
  const url = new URL(proxy.url);
  return url.username !== "" || url.password !== "";
}

/** Windows environment names are case-insensitive, so only the upper-case spelling is set. */
function windowsProxyEnvironment(env: NodeJS.ProcessEnv, proxy: NetworkProxy | undefined) {
  if (!proxy || proxyCredentials(proxy)) return;
  const value = new URL(proxy.url).href.replace(/\/$/, "");
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) env[name] = value;
  env.NO_PROXY = "localhost,127.0.0.1,::1";
}
