import { lstat, rm } from "node:fs/promises";
import { win32 } from "node:path";
import { ExecError } from "../core/types.ts";
import { findGit, type GitProcessOptions, spawnGit } from "./git-process.ts";
import { type GitWriteOperation, gitWriteSteps } from "./git-write.ts";

export interface DirectGitWriteResult {
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stopped: boolean;
}

/**
 * Windows exception to sandboxed Git writes: Windows has no command sandbox, so the user's own
 * discard /
 * commit clicks in the changes sidebar run Git directly. Only brain's changes.discard and
 * changes.commit RPC handlers may call this; it is never reachable from a Bot tool. The hardening
 * that replaces isolation: Git only from its fixed install location, the read runner's `-c`
 * overrides (hooks unreachable, no fsmonitor / pager / transports / credential helpers),
 * `--no-verify`, a clean environment without host GIT_* variables, no shell, a deadline and
 * cancellation. Brain keeps the folder checks (primary folder only, .git inside it) and the audit.
 */
export async function runGitWriteDirect(
  options: GitProcessOptions,
  input: {
    cwd: string;
    operations: GitWriteOperation[];
    signal: AbortSignal;
    timeoutMs?: number;
    assertAuthorized?(): void;
  },
): Promise<DirectGitWriteResult> {
  // POSIX writes must stay inside the sandbox; this path exists only where none is available.
  if (options.platform !== "win32") throw new ExecError("isolation_unavailable");
  if (
    input.operations.some(
      (operation) =>
        operation.kind === "createRef" ||
        operation.kind === "switchBranch" ||
        operation.kind === "sync",
    )
  )
    throw new ExecError("isolation_unavailable");
  const timeoutMs = input.timeoutMs ?? 120_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 600_000 ||
    !win32.isAbsolute(input.cwd) ||
    !input.operations.length
  )
    throw new ExecError("invalid_input");
  const executable = await findGit(options);
  if (!executable) throw new ExecError("git_unavailable");
  // Every step is built (and validated) before the first one changes anything.
  const steps = input.operations.flatMap((operation) =>
    gitWriteSteps(options.platform, executable, operation),
  );
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([input.signal, timeout]);
  const started = performance.now();
  const finish = (exitCode: number | null) => ({
    exitCode,
    durationMs: Math.round(performance.now() - started),
    timedOut: timeout.aborted && !input.signal.aborted,
    stopped: input.signal.aborted,
  });
  for (const step of steps) {
    if (signal.aborted) return finish(null);
    if ("unlink" in step) {
      // Same as the sandbox's `rm -f`: a missing file is fine, a directory is refused.
      input.assertAuthorized?.();
      signal.throwIfAborted();
      await rm(step.unlink, { force: true });
      continue;
    }
    const stepStarted = Date.now();
    try {
      const result = await spawnGit(options, {
        executable,
        args: step.git,
        cwd: input.cwd,
        signal,
        cancelled: () => input.signal.aborted,
        maxBytes: 1024 * 1024,
        assertAuthorized: input.assertAuthorized,
      });
      if (result.exitCode !== 0) return finish(result.exitCode);
    } catch (error) {
      // Timeout and cancellation are results, like runCommand's; anything else is a real failure.
      if (signal.aborted) {
        await releaseKilledIndexLock(input.cwd, stepStarted);
        return finish(null);
      }
      throw error;
    }
  }
  return finish(0);
}

/**
 * A Git killed mid-write leaves `.git/index.lock`, and every later discard / commit then fails
 * until the user deletes it by hand. spawnGit only settles after the killed tree has closed its
 * pipes, so no process of ours still holds the lock. Only a lock created while that step ran is
 * removed: Git refuses to start on an existing lock, so an older one belongs to someone else.
 */
async function releaseKilledIndexLock(cwd: string, since: number) {
  const lock = win32.join(cwd, ".git", "index.lock");
  try {
    const info = await lstat(lock);
    // mtime, not birthtime: NTFS "tunneling" gives a file recreated under a name deleted within
    // 15 s (Git's own previous lock) the old creation time. 1 s slack for timestamp granularity.
    // Retries cover the killed process's handle closing just after its pipes did.
    if (info.isFile() && info.mtimeMs >= since - 1000)
      await rm(lock, { force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // No lock (the usual case) or it vanished meanwhile: nothing to release.
  }
}
