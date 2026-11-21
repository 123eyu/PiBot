import { randomUUID } from "node:crypto";
import { lstatSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type MacArtifact, nativeMacDirectory } from "./app-artifact.ts";
import { inspectMacArtifactAsync } from "./app-artifact-async.ts";
import { type AsyncCommandResult, runLoggedAsync } from "./async-command.ts";
import { exceptionReason } from "./check-failure.ts";
import { pnpmEnv, store } from "./context.ts";
import { acquireDirectoryLock } from "./operation-lock.ts";
import { packageProcessGuard } from "./package-process-guard.ts";
import type { TaskRecord } from "./state.ts";
import { ensureElectronAsync } from "./windows/electron.ts";

export const packageLog = (runId: string) => join(store.dir, "logs", `mac-package-${runId}.json`);
export interface PackageResult {
  ok: boolean;
  outcome: "ok" | "failed" | "harness_failed";
  detail: string;
  log: string;
  durationMs: number;
  artifact?: MacArtifact;
}

/** The dead CLI is not proof its detached packager group ended; unknown leases need recovery. */
function recoverable(lock: string) {
  for (const file of ["inflight.json", "unconfirmed.json"]) {
    try {
      lstatSync(join(lock, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("package_cleanup_unconfirmed");
  }
}

export async function packageMacAsync(
  task: Pick<TaskRecord, "id" | "worktree">,
  signal: AbortSignal,
  runId: string = randomUUID(),
): Promise<PackageResult> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(45 * 60_000)]);
  const started = Date.now();
  const result: PackageResult = {
    ok: false,
    outcome: "harness_failed",
    detail: "package_incomplete",
    log: packageLog(runId),
    durationMs: 0,
  };
  let release: (() => void) | undefined;
  let retained = false;
  let latest: AsyncCommandResult | undefined;
  let guard: Awaited<ReturnType<typeof packageProcessGuard>> | undefined;
  const lock = join(store.dir, `package-${task.id}.lock`);
  const unknown = (pid?: number) => {
    retained = true;
    writeFileSync(
      join(lock, "unconfirmed.json"),
      JSON.stringify({ reason: "package_cleanup_unconfirmed", pid, ownerPid: process.pid }),
      { flag: "wx", mode: 0o600 },
    );
  };
  const execute = async (name: string, command: string, args: string[], timeoutMs: number) => {
    latest = await runLoggedAsync(task.id, name, command, args, {
      cwd: task.worktree,
      env: name === "package" ? guard?.env : pnpmEnv,
      signal,
      timeoutMs,
    });
    if (!latest.drained || (guard && (await guard.escaped()))) {
      unknown(latest.pid);
      throw new Error("package_cleanup_unconfirmed");
    }
    return latest;
  };
  try {
    signal.throwIfAborted();
    if (process.platform !== "darwin") throw new Error("package_host_unsupported");
    if (!/^[a-z0-9-]+$/.test(task.id) || !/^[a-f0-9-]{36}$/.test(runId))
      throw new Error("package_identity_invalid");
    await mkdir(join(store.dir, "logs"), { recursive: true });
    await writeFile(result.log, `${JSON.stringify({ runId, phase: "preparing" })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    recoverable(lock);
    release = acquireDirectoryLock(lock, () => recoverable(lock));
    // Written before subprocesses: even a crash or failed unknown-marker write cannot reap a lease
    // whose children were never confirmed ended. Known completion removes it with the lease.
    writeFileSync(join(lock, "inflight.json"), JSON.stringify({ runId, ownerPid: process.pid }), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await ensureElectronAsync(task.worktree, { signal });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "electron_preflight:local_process_cleanup_unconfirmed"
      )
        unknown();
      throw error;
    }
    guard = await packageProcessGuard(lock, pnpmEnv);
    const run = await execute(
      "package",
      "pnpm",
      ["--filter", "@pibot/desktop", "package", "--mac", "--dir"],
      30 * 60_000,
    );
    signal.throwIfAborted();
    if (!run.ok) {
      result.outcome =
        run.errorCode || run.signal || run.cancelled || run.timedOut || run.code === 78
          ? "harness_failed"
          : "failed";
      result.detail = run.timedOut
        ? "workflow_timeout"
        : run.code === 78
          ? "package_tracking_unavailable"
          : (run.errorCode ?? "package_failed");
    } else {
      const artifact = await inspectMacArtifactAsync(
        join(task.worktree, "apps", "desktop", "dist", nativeMacDirectory(), "Pi Bot.app"),
        signal,
        {
          run: async (command, args, current, timeoutMs = 30_000) => {
            current.throwIfAborted();
            const checked = await execute("package-artifact", command, args, timeoutMs);
            if (!checked.ok) throw new Error("package_artifact_command_failed");
            return checked.text().trim();
          },
        },
      );
      signal.throwIfAborted();
      const target = join(task.worktree, "apps", "desktop", "dist", ".pibot-mac-artifact.json");
      const pending = `${target}.${runId}.tmp`;
      try {
        await writeFile(pending, `${JSON.stringify(artifact)}\n`, {
          flag: "wx",
          mode: 0o600,
          signal,
        });
        signal.throwIfAborted();
        await rename(pending, target);
      } finally {
        await rm(pending, { force: true });
      }
      signal.throwIfAborted();
      Object.assign(result, { ok: true, outcome: "ok", detail: "package_verified", artifact });
    }
  } catch (error) {
    result.ok = false;
    result.outcome = "harness_failed";
    result.detail = retained
      ? "package_cleanup_unconfirmed"
      : signal.aborted
        ? "workflow_cancelled"
        : error instanceof Error && /^package_[a-z_]{1,80}$/.test(error.message)
          ? error.message
          : exceptionReason(error);
  } finally {
    if (!retained) release?.();
  }
  result.durationMs = Date.now() - started;
  // Summary I/O can fail after the command finished. Return its safe partial diagnostics, while
  // retaining an unknown lease and never turning an unwritten summary into a successful receipt.
  try {
    await writeFile(
      result.log,
      `${JSON.stringify({ runId, outcome: result.outcome, detail: result.detail, commandLog: latest?.log })}\n`,
      { mode: 0o600 },
    );
  } catch {
    result.ok = false;
    result.outcome = "harness_failed";
    result.detail = retained ? "package_cleanup_unconfirmed" : "package_summary_unavailable";
    result.log = latest?.log ?? result.log;
  }
  return result;
}
