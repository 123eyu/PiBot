import { type FSWatcher, watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { createStartupWake } from "./startup-wake.ts";

/** Only ESRCH proves a process is gone; EPERM and anything else is treated as alive. */
export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Proof of owner death: its descriptor is withdrawn and its PID is gone. */
export async function waitBackgroundExit(
  dataDir: string,
  pid: number,
  signal = AbortSignal.timeout(100_000),
) {
  const directory = join(dataDir, "background-runtime");
  const wake = createStartupWake();
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(directory, { persistent: false }, () => wake.notify());
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
      wake.notify();
    });
  } catch {
    // Unwatchable filesystems still use a bounded PID check.
  }
  try {
    while (!signal.aborted) {
      let descriptorAbsent = false;
      try {
        await lstat(join(directory, "owner.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") descriptorAbsent = true;
        else throw error;
      }
      if (descriptorAbsent && !processAlive(pid)) return;
      // Descriptor withdrawal wakes us immediately. A PID can disappear without a filesystem
      // event (notably after release); Node has no portable exit subscription for a foreign PID.
      await wake.wait(descriptorAbsent ? 25 : 50, signal).catch(() => {});
    }
    throw new Error("background_actual_exit_unconfirmed");
  } finally {
    watcher?.close();
  }
}
