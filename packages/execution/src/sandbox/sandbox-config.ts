import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js";
import { skillPythonPaths } from "../command/skill-python.ts";
import { canonicalPath, within } from "../core/paths.ts";
import { ExecError, type ExecOptions, type NetworkSettings } from "../core/types.ts";
import { gitDefaultWriteDenies, gitMetadataWriteDenies } from "../git/git-init-sandbox.ts";
import { linuxGitWriteDenies } from "../git/git-protected-paths.ts";
import { bundledNodePath } from "../runtime/child-node.ts";
import { profileRoot } from "./profile-paths.ts";
import { type BotReadContext, sensitiveReadBoundary } from "./sensitive-paths.ts";
import { commandTempBoundary } from "./temp-boundary.ts";
import { verifyCommandAliases } from "./workspace.ts";

/**
 * Read-only system services that are safe for every sandbox. configd is used by uv, cargo, Go and
 * other Rust/Go tools to read proxy settings through SCDynamicStore; refusing it yields a NULL
 * store and can panic. trustd and trustd.agent perform certificate trust evaluation; they answer
 * whether a certificate is trusted and do not expose passwords or widen network policy. The Go
 * HTTPS probe failed with OSStatus -26276 until these two services were allowed. Keep this list
 * deliberately small: every entry needs a local probe result before it is added.
 */
export const SAFE_SYSTEM_SERVICES = [
  "com.apple.SystemConfiguration.configd",
  "com.apple.trustd",
  "com.apple.trustd.agent",
] as const;

/** Sandbox host sockets live under the exec temp dir: short enough for 104-byte socket paths. */
export const SANDBOX_HOST_DIR = "pibot-srt";

/**
 * ripgrep and (Linux) the seccomp helper SRT needs, resolved from the packaged resources or the
 * workspace; shared by command hosts and external-agent hosts. A missing helper fails closed.
 */
export function createSandboxDependencies(options: Pick<ExecOptions, "platform" | "resourcesDir">) {
  let ripgrep: Promise<string> | undefined;
  const ripgrepPath = () => {
    ripgrep ??= (async () => {
      const rg = options.resourcesDir
        ? join(options.resourcesDir, "bin", options.platform === "win32" ? "rg.exe" : "rg")
        : (await import("@vscode/ripgrep")).rgPath;
      await access(rg, constants.X_OK);
      return rg;
    })().catch((error) => {
      ripgrep = undefined;
      throw error;
    });
    return ripgrep;
  };
  let pending: Promise<{ rg: string; helper?: string }> | undefined;
  const dependencies = () => {
    pending ??= (async () => {
      const require = createRequire(import.meta.url);
      const rg = await ripgrepPath();
      let helper: string | undefined;
      if (options.platform === "linux") {
        const runtime = join("node_modules", "@anthropic-ai", "sandbox-runtime");
        // Packages unpack SRT's executables to resources/app.asar.unpacked (asarUnpack); there is
        // no resources/node_modules. Looking only there made every packaged Linux command report
        // isolation_unavailable. The module's own location
        // covers development, where resourcesDir holds only bin/ and wasm/.
        const candidates = [
          ...(options.resourcesDir
            ? [
                join(options.resourcesDir, "app.asar.unpacked", runtime),
                join(options.resourcesDir, runtime),
              ]
            : []),
          dirname(dirname(require.resolve("@anthropic-ai/sandbox-runtime"))).replace(
            `${sep}app.asar${sep}`,
            `${sep}app.asar.unpacked${sep}`,
          ),
        ];
        for (const base of candidates) {
          const candidate = join(base, "vendor", "seccomp", process.arch, "apply-seccomp");
          const real = await realpath(candidate).catch(() => undefined);
          if (!real) continue;
          if (
            await access(real, constants.X_OK).then(
              () => true,
              () => false,
            )
          ) {
            helper = real;
            break;
          }
        }
        if (!helper) throw new ExecError("isolation_unavailable", "seccomp_helper_unavailable");
      }
      return { rg, ...(helper ? { helper } : {}) };
    })().catch((error) => {
      // No host exists yet: a missing dependency may be repaired before the next status probe.
      pending = undefined;
      throw error;
    });
    return pending;
  };
  return { dependencies, ripgrepPath };
}

/** Checked executable paths shared by legacy probes and isolated command hosts. */
export function createSandboxConfig(options: ExecOptions) {
  const { dependencies, ripgrepPath } = createSandboxDependencies(options);
  async function writeRoot(root: string, index: number, bot?: BotReadContext) {
    const paths = bot?.skillPythonPreparation
      ? skillPythonPaths(bot.dataDir, bot.skillPythonPreparation)
      : undefined;
    const kind =
      paths && resolve(root) === resolve(paths.env)
        ? "env"
        : paths && resolve(root) === resolve(paths.python)
          ? "python"
          : paths && resolve(root) === resolve(paths.cache)
            ? "cache"
            : paths && resolve(root) === resolve(paths.uv)
              ? "uv"
              : bot && resolve(root) === resolve(bot.botHome)
                ? "home"
                : bot?.skillPythonPreparation
                  ? "other"
                  : "workplace";
    try {
      return await profileRoot(root, "profile_write_root");
    } catch (error) {
      if (error instanceof ExecError && error.reason === "profile_write_root")
        throw new ExecError("outside_workplace", "profile_write_root", { index: index + 1, kind });
      throw error;
    }
  }
  async function config(
    roots: string[],
    network: NetworkSettings,
    signal: AbortSignal,
    bot?: BotReadContext,
    denied: string[] = [],
    gitConfig = false,
    gitDirectories = false,
    gitDirectory?: string,
    localBinding = false,
    commandTempDir?: string,
    readonlyReferences = false,
    readRoots: readonly string[] = [],
  ) {
    const { rg, helper } = await dependencies();
    const temp = await realpath(options.tempDir);
    // Created up front: on Linux a missing deny path would become a mount-point file.
    const hosts = join(temp, SANDBOX_HOST_DIR);
    await mkdir(hosts, { recursive: true, mode: 0o700 });
    // Commands receive only their private temp folder. Scanning the shared OS temp tree
    // encounters unrelated protected app folders; skipping those would miss writable aliases.
    // Initialization only writes the authorized .git, without any writable temp directory.
    const canonical = [
      ...new Set([
        ...(await Promise.all(roots.map((root, index) => writeRoot(root, index, bot)))),
        ...(gitConfig || gitDirectories
          ? []
          : [await profileRoot(commandTempDir ?? temp, "profile_temp_root")]),
      ]),
    ];
    const reads = await sensitiveReadBoundary(
      options.platform,
      [...new Set([options.systemHome, homedir(), ...(bot ? [bot.botHome] : [])])],
      options.env,
      bot,
    );
    // Selected projects remain readable in OS temp even when a query receives no write roots.
    const temporary = await commandTempBoundary(
      temp,
      commandTempDir,
      options.platform,
      [
        ...canonical,
        ...(await Promise.all(readRoots.map((root) => profileRoot(root, "profile_read_root")))),
      ],
      [
        ...(helper ? [dirname(helper)] : []),
        ...(options.platform === "linux" && options.resourcesDir
          ? [dirname(bundledNodePath(options.resourcesDir, options.platform))]
          : []),
      ],
    );
    const defaults = await Promise.all(
      [...new Set([options.systemHome, homedir()])].flatMap((home) =>
        [".npm/_logs", ".claude/debug"].map((path) => canonicalPath(join(home, path), home)),
      ),
    );
    const effectiveRoots = canonical.filter(reads.permitsWriteRoot);
    const writeDenies = [
      ...denied,
      // Include the runtime in alias verification as well as the readonly sandbox binds.
      ...(helper ? [dirname(helper)] : []),
      // A command must not replace or remove another Bot's sandbox-host proxy sockets.
      ...(effectiveRoots.some((root) => within(root, hosts)) ? [hosts] : []),
      ...reads.readOnly.filter((path) => effectiveRoots.some((root) => within(root, path))),
      ...(gitConfig || gitDirectories || denied.length || readonlyReferences
        ? await gitDefaultWriteDenies(canonical)
        : []),
      ...(gitConfig ? roots.map((root) => join(root, "hooks")) : []),
      ...defaults.filter((path) => !canonical.some((root) => within(root, path))),
    ];
    // The status probe isn't an agent command. Scan only the actual command's readable write roots.
    if (options.platform === "linux" && bot) {
      const permitsRead = (path: string) =>
        reads.permitsWriteRoot(path) && !writeDenies.some((root) => within(root, path));
      if ((gitConfig || gitDirectories) && !gitDirectory) throw new ExecError("invalid_input");
      writeDenies.push(
        ...(await linuxGitWriteDenies({
          roots: effectiveRoots,
          permitsRead,
          signal,
          ...(gitDirectory
            ? {
                initialization: {
                  gitDirectory,
                  phase: gitDirectories ? "directories" : "initialize",
                } as const,
              }
            : {}),
        })),
      );
      // A readonly bind protects a pathname, not another writable name for its inode.
      // Include automatic Git protection before scanning; the caller's explicit denies
      // alone are empty for ordinary commands and would skip existing hard-link aliases.
      writeDenies.push(
        ...(await verifyCommandAliases(
          effectiveRoots,
          writeDenies,
          signal,
          options.aliasFileSystem,
          true,
        )),
      );
    }
    signal.throwIfAborted();
    const parent = options.proxy?.();
    const value = SandboxRuntimeConfigSchema.parse({
      // The SDK composes these from its own host env, even when spawn uses a clean env.
      credentials: {
        envVars: ["JAVA_TOOL_OPTIONS", "GIT_CONFIG_COUNT"].map((name) => ({
          name,
          mode: "deny",
        })),
      },
      network: {
        allowedDomains: network.domains,
        deniedDomains: [],
        strictAllowlist: !network.allowAll,
        // Background commands may listen (local services). On macOS SRT's switch admits
        // bind/inbound on every address plus outbound to any loopback port (Seatbelt cannot tell
        // 127.0.0.1 from 0.0.0.0), so exec's background monitor stops non-loopback listeners.
        // Linux ignores it: bubblewrap's own network namespace already allows a private bind.
        allowLocalBinding: localBinding,
        ...(options.platform === "darwin" ? { allowMachLookup: [...SAFE_SYSTEM_SERVICES] } : {}),
        ...(parent ? { parentProxy: { http: parent.url, https: parent.url, noProxy: "" } } : {}),
      },
      filesystem: {
        allowGitConfig: gitConfig,
        // Manifest data follows the existing write grant, including future unpack paths. Git
        // config/hooks and explicit denies remain independent; init recipes retain their scope.
        gitManifestWriteRoots:
          (options.platform === "darwin" || options.platform === "linux") &&
          bot &&
          !gitConfig &&
          !gitDirectories
            ? effectiveRoots
            : [],
        denyRead: [
          ...reads.denyRead.map((path) => ({ path, literal: true })),
          ...reads.denyReadGlobs,
          ...temporary.denyRead,
        ],
        allowRead: [
          ...reads.allowRead.map((path) => ({ path, literal: true })),
          ...temporary.allowRead,
        ],
        allowWrite: effectiveRoots.map((path) => ({ path, literal: true })),
        denyWrite: [
          ...[...new Set(writeDenies)].map((path) => ({ path, literal: true })),
          // These must remain glob entries: marking them literal would protect a nonexistent name.
          // Their '/' anchor adds no target/.git ancestor pin before the trusted mkdir phase.
          ...gitMetadataWriteDenies(options.platform, gitConfig),
          ...temporary.denyWrite,
        ],
      },
      ripgrep: { command: rg },
      ...(helper ? { seccomp: { applyPath: helper } } : {}),
    });
    // SRT 0.0.79 resolves with ??, so empty strings explicitly disable ambient fallback.
    // Its URL schema rejects this trusted sentinel; public initialize/updateConfig accept it.
    value.network.parentProxy = parent
      ? { http: parent.url, https: parent.url, noProxy: "" }
      : { http: "", https: "", noProxy: "" };
    return value;
  }
  return { config, dependencies, ripgrepPath };
}
