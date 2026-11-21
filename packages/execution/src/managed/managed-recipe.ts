import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { commandEnvironment } from "../command/environment.ts";
import { executeHostedCommand } from "../command/foreground-host.ts";
import { executeProcess } from "../command/process.ts";
import { ExecError, type ExecOptions } from "../core/types.ts";
import { gitDefaultWriteDenies } from "../git/git-init-sandbox.ts";
import { createSandboxConfig } from "../sandbox/sandbox-config.ts";
import { sensitiveReadBoundary } from "../sandbox/sensitive-paths.ts";
import { holdManagedPaths, type ManagedPathIdentity } from "./managed-boundary.ts";
import { managedIdentityStrategy } from "./managed-identity.ts";

export interface ManagedRecipe {
  cwd: string;
  home: string;
  dataDir: string;
  signal: AbortSignal;
  identities: ManagedPathIdentity[];
  /** Called immediately before SRT acknowledges dispatch, not just when UI prepared the action. */
  assertAuthorized(): void;
  command: string;
  windowsSteps?: { executable: string; args: string[] }[];
  windowsRollback?: { executable: string; args: string[] };
  label: "managed_git" | "checkpoint_restore";
  /** Only fixed Git sync recipes supply a single validated HTTPS domain. */
  network?: import("../core/types.ts").NetworkSettings;
  returnFailure?: boolean;
  writePaths: string[];
  readPaths?: string[];
  denyPaths?: string[];
  removedPaths?: string[];
  /** Only file-checkpoint.ts supplies this pre-existing app-private, fixed-format journal. */
  privateJournal?: string;
  /** Fixed checkpoint recipe only; exact app-private files directory or one item beneath it. */
  privateRecovery?: string;
  beforeDispatch?(): Promise<void>;
}
/** Purpose-bound recipes have no unisolated fallback and never inherit model-supplied commands. */
export async function runManagedRecipe(options: ExecOptions, input: ManagedRecipe) {
  if (!["darwin", "linux", "win32"].includes(options.platform))
    throw new ExecError("isolation_unavailable");
  if (typeof input.assertAuthorized !== "function" || !input.identities.length)
    throw new ExecError("invalid_input");
  if (input.privateRecovery) {
    const recoveryParent = dirname(input.privateRecovery);
    const root = join(
      input.dataDir,
      "bots",
      input.home.split(/[\\/]/).at(-2) ?? "",
      "file-checkpoints",
    );
    const parts = relative(root, input.privateRecovery).split(sep),
      uuid = /^[0-9a-f-]{36}$/;
    if (
      input.label !== "checkpoint_restore" ||
      ![4, 5].includes(parts.length) ||
      !uuid.test(parts[0] ?? "") ||
      parts[1] !== "restores" ||
      !uuid.test(parts[2] ?? "") ||
      parts[3] !== "files" ||
      (parts.length === 5 && !uuid.test(parts[4] ?? "")) ||
      !input.identities.some((entry) => entry.path === recoveryParent)
    )
      throw new ExecError("outside_workplace");
  }
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]);
  const strategy = managedIdentityStrategy(options.platform);
  const held =
    (await strategy.hold(input.identities, signal, input.assertAuthorized)) ??
    (await holdManagedPaths(input.identities, signal, input.assertAuthorized));
  const id = randomUUID();
  const directory = join(options.tempDir, "managed-operations");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const log = createWriteStream(join(directory, `${id}.log`), { flags: "wx", mode: 0o600 });
    try {
      // Open failures must be observed before asynchronous sandbox preparation starts.
      await once(log, "open");
      const boundary = await sensitiveReadBoundary(
        options.platform,
        [options.systemHome, input.home],
        options.env,
        { botHome: input.home, dataDir: input.dataDir },
      );
      if (input.writePaths.some((path) => !boundary.permitsWriteRoot(path)))
        throw new ExecError("outside_workplace");
      if (options.platform === "win32") {
        const env = commandEnvironment(options.platform, options.env, input.home, options.tempDir);
        for (const key of Object.keys(env))
          if (key.toUpperCase().startsWith("GIT_")) delete env[key];
        env.GIT_CONFIG_NOSYSTEM = "1";
        env.GIT_CONFIG_GLOBAL = "NUL";
        const steps = input.windowsSteps ?? [];
        let result: Awaited<ReturnType<typeof executeProcess>> | undefined;
        try {
          for (const step of steps) {
            await held.check();
            result = await executeProcess({
              shell: step.executable,
              args: step.args,
              cwd: input.cwd,
              env,
              platform: options.platform,
              signal,
              log,
              redactor: options.redactor,
              beforeSpawn: input.assertAuthorized,
            });
            if (result.exitCode !== 0) throw new ExecError("command_failed");
            // A removal step deletes its own worktree; that path cannot be re-verified afterwards.
            await held.check(new Set(input.removedPaths));
          }
        } catch (error) {
          if (input.windowsRollback) {
            await held.check();
            await executeProcess({
              shell: input.windowsRollback.executable,
              args: input.windowsRollback.args,
              cwd: input.cwd,
              env,
              platform: options.platform,
              signal,
              log,
              redactor: options.redactor,
              beforeSpawn: input.assertAuthorized,
            });
            await held.check();
          }
          // The caller reports a failed merge (conflict) from the result, as on macOS / Linux.
          if (
            input.returnFailure &&
            result &&
            error instanceof ExecError &&
            error.code === "command_failed"
          )
            return result;
          throw error;
        }
        await held.check(new Set(input.removedPaths));
        if (!result) throw new ExecError("invalid_input");
        return result;
      }
      const sandbox = createSandboxConfig(options);
      const config = await sandbox.config(
        input.identities.map((value) => value.path),
        input.network ?? { allowAll: false, domains: [] },
        signal,
        { botHome: input.home, dataDir: input.dataDir },
      );
      // Replace the broad setup roots with exact recipe capabilities. Never expose this profile to runCommand.
      config.filesystem.allowWrite = [
        ...input.writePaths,
        ...(input.privateJournal ? [input.privateJournal] : []),
        ...(input.privateRecovery ? [input.privateRecovery] : []),
      ].map((path) => ({ path, literal: true }));
      // The fixed recipe replaced the ordinary command roots; no broad manifest class survives.
      config.filesystem.gitManifestWriteRoots = [];
      config.filesystem.allowRead ??= [];
      config.filesystem.allowRead.push(
        ...[
          ...(input.readPaths ?? []),
          ...(input.privateRecovery ? [input.privateRecovery] : []),
        ].map((path) => ({ path, literal: true as const })),
      );
      config.filesystem.denyWrite.push(
        ...[...(input.denyPaths ?? []), ...(await gitDefaultWriteDenies(input.writePaths))].map(
          (path) => ({ path, literal: true as const }),
        ),
      );
      const env = commandEnvironment(options.platform, options.env, input.home, options.tempDir);
      const result = await executeHostedCommand({
        options,
        config,
        allowAll: false,
        command: input.command,
        commandText: input.label,
        commandId: id,
        cwd: input.cwd,
        env,
        signal,
        log,
        dispatch: input.assertAuthorized,
        prepared: async () => {
          await held.check();
          await input.beforeDispatch?.();
          await held.check();
        },
      });
      await held.check(new Set(input.removedPaths));
      if (result.exitCode !== 0 && !input.returnFailure) throw new ExecError("command_failed");
      return result;
    } finally {
      log.end();
    }
  } finally {
    await held.close();
  }
}
