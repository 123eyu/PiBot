import { type ChildProcess, spawn } from "node:child_process";
import { sep } from "node:path";
import type { Readable } from "node:stream";

/**
 * What all rg listings of one search may hold together. Paths are counted as raw bytes before
 * they are decoded, and as entries (each costs far more than its bytes in the heap); running out
 * is not an answer, so the caller falls back to the JS walk rather than search a prefix.
 */
export type RgBudget = { bytes: number; entries: number };
export const rgBudget = (): RgBudget => ({ bytes: 32 * 1024 * 1024, entries: 200_000 });

export type RgCleanupCode = "search_rg_cleanup_failed" | "search_rg_cleanup_recovered";

const MAX_PATH_BYTES = 64 * 1024;
// Windows rg may print either separator; a POSIX name can legally contain a backslash.
const SEPARATOR = sep === "\\" ? /[\\/]/ : /\//;
const CLOSE_GRACE_MS = 2_000;

function closesWithin(closed: Promise<void>, ms: number) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void closed.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * True only once 'close' confirmed the child and its stdio are gone. A finished listing first gets
 * the grace period to exit by itself (its exit code is the answer); a stopped one is asked to
 * stop at once. Either way SIGTERM is followed by SIGKILL.
 */
async function reap(child: ChildProcess, closed: Promise<void>, stopping: boolean) {
  if (!stopping && (await closesWithin(closed, CLOSE_GRACE_MS))) return true;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  if (await closesWithin(closed, CLOSE_GRACE_MS)) return true;
  child.kill("SIGKILL");
  return closesWithin(closed, CLOSE_GRACE_MS);
}

/**
 * "complete": rg ran to its own end and the listing is whole. "stopped": the caller's `stop`
 * ended it early and no failure had shown before that moment, so what was handed over stands.
 * "failed": anything else; the caller reruns on JS.
 */
export type RgListingStatus = "complete" | "stopped" | "failed";

/**
 * Runs rg with the root as cwd and "." as the only path, handing each printed root-relative name
 * ("a/b", always "/"-joined) to `onPath` in rg's order, as it arrives.
 *
 * `signal` is the search's own life (caller stop, deadline): it ends the run and is rethrown.
 * `stop` is "enough": the cap was reached, or a sibling listing failed.
 *
 * Whatever ends the run (end of output, a stop, the deadline, a full budget), stdout is torn
 * down at once, so a child that ignores SIGTERM and keeps its pipe open cannot hold the read;
 * the termination then runs to a confirmed 'close', escalating to SIGKILL. A child that is still
 * not confirmed gone is reported with a fixed code and watched until it does close.
 */
export async function listRg(
  run: { executable: string; args: string[]; cwd: string },
  budget: RgBudget,
  signal: AbortSignal,
  stop: AbortSignal,
  onPath: (name: string) => void | Promise<void>,
  report: (code: RgCleanupCode) => void,
): Promise<RgListingStatus> {
  signal.throwIfAborted();
  if (stop.aborted) return "stopped";
  let child: ChildProcess;
  try {
    child = spawn(run.executable, run.args, {
      cwd: run.cwd,
      // rg needs no environment; an empty one keeps RIPGREP_CONFIG_PATH and friends out.
      env: {},
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Node rejects some spawn failures synchronously; they mean "no usable rg" like async ones.
    return "failed";
  }
  let spawnError = false;
  child.once("error", () => {
    spawnError = true;
  });
  // A child that never started has nothing to wait for; otherwise only 'close' means it is gone.
  const closed =
    child.pid === undefined
      ? undefined
      : new Promise<void>((resolve) => child.once("close", () => resolve()));
  // rg reports every unreadable file or folder on stderr (and exits 2). Only the fact is kept:
  // the text names paths, and an incomplete listing is rerun on JS, which counts them itself.
  let complained = false;
  child.stderr?.on("data", () => {
    complained = true;
  });
  let ending: Promise<boolean> | undefined;
  let stopping = false;
  const end = (stop: boolean) => {
    if (stop) {
      stopping = true;
      // Unblocks the read even when the child ignores SIGTERM and keeps its stdout open.
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    ending ??= closed ? reap(child, closed, stop) : Promise.resolve(true);
    return ending;
  };
  const healthy = () =>
    !spawnError && !complained && (child.exitCode === null || child.exitCode <= 1);
  // Judged at the moment of the stop: a failure rg had already shown still sends the call to JS;
  // the exit our own kill causes afterwards is not one.
  let stoppedHealthy: boolean | undefined;
  const onAbort = () => void end(true);
  const onStop = () => {
    stoppedHealthy ??= usable && healthy();
    void end(true);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  stop.addEventListener("abort", onStop, { once: true });
  let usable = true;
  try {
    let pending: Buffer = Buffer.alloc(0);
    read: for await (const chunk of child.stdout as Readable) {
      const bytes = chunk as Buffer;
      budget.bytes -= bytes.length;
      if (budget.bytes < 0) {
        usable = false;
        break;
      }
      pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      let start = 0;
      for (let at = pending.indexOf(0, start); at >= 0; at = pending.indexOf(0, start)) {
        const printed = pending.toString("utf8", start, at);
        start = at + 1;
        // rg was given ".", so every path is "./a/b" (".\a\b" on Windows) below the root.
        const parts = /^\.[\\/]/.test(printed) ? printed.slice(2).split(SEPARATOR) : [];
        if (
          !parts.length ||
          parts.some((part) => !part || part === "." || part === "..") ||
          --budget.entries < 0
        ) {
          usable = false;
          break read;
        }
        const waited = onPath(parts.join("/"));
        if (waited) await waited;
        if (signal.aborted || stop.aborted) break read;
      }
      pending = pending.subarray(start);
      if (pending.length > MAX_PATH_BYTES) {
        usable = false;
        break;
      }
    }
    if (pending.length) usable = false;
  } catch {
    // A torn-down pipe (stop, deadline) or a broken one: either way this listing is not usable.
    usable = false;
  } finally {
    signal.removeEventListener("abort", onAbort);
    stop.removeEventListener("abort", onStop);
  }
  const confirmed = await end(!usable || signal.aborted || stop.aborted);
  if (!confirmed && closed) {
    report("search_rg_cleanup_failed");
    void closed.then(() => report("search_rg_cleanup_recovered"));
  }
  signal.throwIfAborted();
  if (!confirmed) return "failed";
  if (stoppedHealthy !== undefined) return stoppedHealthy ? "stopped" : "failed";
  // 0 = something printed, 1 = nothing matched; anything else, a complaint, or a cut-short read
  // means the list may be missing files, which only a JS walk can report honestly.
  return usable && !stopping && healthy() && child.exitCode !== null ? "complete" : "failed";
}
