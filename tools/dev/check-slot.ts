import { spawn } from "node:child_process";
import { join } from "node:path";
import { acquireCheckSlot, inheritedCheckSlot } from "./check-slot-lease.ts";

/** The supervisor owns the lease; nested checks share it until the entire outer command exits. */
export async function enterCheckSlot(): Promise<void> {
  if (inheritedCheckSlot(process.env.PIBOT_CHECK_SLOT_LEASE)) return;
  const lifetime = new AbortController();
  let stop: (() => void) | undefined;
  let exitCode = 1;
  const interrupt = () => {
    exitCode = 130;
    lifetime.abort();
    stop?.();
  };
  const terminate = () => {
    exitCode = 143;
    lifetime.abort();
    stop?.();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let lease: Awaited<ReturnType<typeof acquireCheckSlot>> | undefined;
  try {
    lease = await acquireCheckSlot(lifetime.signal);
    lifetime.signal.throwIfAborted();
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      env: { ...process.env, PIBOT_CHECK_SLOT_LEASE: lease.marker },
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let force: ReturnType<typeof setTimeout> | undefined;
    let treeStopped: Promise<void> | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    stop = () => {
      if (treeStopped || force || !child.pid) return;
      if (process.platform === "win32") {
        // Windows signals kill only the immediate child. Use the system tree operation, no shell.
        treeStopped = new Promise((resolve) => {
          const killer = spawn(
            join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"],
            { stdio: "ignore" },
          );
          killer.once("close", (code) => {
            // Keep waiting for the worker itself if Windows cannot stop its tree.
            if (code !== 0 && child.exitCode === null && child.signalCode === null)
              console.error("check slots: could not stop the Windows check process tree");
            resolve();
          });
          killer.once("error", () => resolve());
        });
      } else {
        killGroup("SIGTERM");
        force = setTimeout(() => killGroup("SIGKILL"), 10_000);
      }
    };
    const result = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      let metadataError: unknown;
      child.once("close", (code) => (metadataError ? reject(metadataError) : resolve(code ?? 1)));
      try {
        if (child.pid) lease?.worker(child.pid);
      } catch (error) {
        metadataError = error;
        stop?.();
      }
      if (lifetime.signal.aborted) stop?.();
    }).finally(async () => {
      if (force) clearTimeout(force);
      if (process.platform !== "win32") killGroup("SIGKILL");
      await treeStopped;
    });
    if (!lifetime.signal.aborted) exitCode = result;
  } catch (error) {
    if (!lifetime.signal.aborted) console.error(`check slots: ${(error as Error).message}`);
  } finally {
    lease?.release();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
  process.exit(exitCode);
}
