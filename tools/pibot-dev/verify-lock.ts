import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { store } from "./context.ts";
import { acquireDirectoryLock } from "./operation-lock.ts";

export function assertVerifyRecoverable(lock: string) {
  try {
    lstatSync(join(lock, "unconfirmed.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("verify_cleanup_unconfirmed");
}

/** Uses the legacy lease path; a verified-dead owner can be reaped, unknown descendants cannot. */
export async function withAsyncVerifyLock<T>(
  signal: AbortSignal,
  run: (unknown: (pid: number | undefined) => void) => Promise<T>,
) {
  const lock = join(store.dir, "verify.lock");
  const deadline = Date.now() + 2 * 60 * 60_000;
  let release: (() => void) | undefined;
  while (!release) {
    signal.throwIfAborted();
    assertVerifyRecoverable(lock);
    try {
      release = acquireDirectoryLock(lock, () => assertVerifyRecoverable(lock));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (error.message !== "Operation busy" && (error as NodeJS.ErrnoException).code !== "EEXIST")
      )
        throw error;
      if (Date.now() >= deadline) throw new Error("verify_lock_timeout");
      await delay(250, undefined, { signal });
    }
  }
  let retained = false;
  try {
    signal.throwIfAborted();
    return await run((pid) => {
      // Set before I/O: a failed receipt cannot release an unconfirmed child group.
      retained = true;
      writeFileSync(
        join(lock, "unconfirmed.json"),
        JSON.stringify({ reason: "process_cleanup_unconfirmed", pid, ownerPid: process.pid }),
        { flag: "wx", mode: 0o600 },
      );
    });
  } finally {
    if (!retained) release();
  }
}
