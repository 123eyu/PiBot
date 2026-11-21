import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/** A per-scope atomic directory, shared by all mutating commands and released by its owner only. */
export function acquireOperationLock(directory: string, scope: string): () => void {
  if (!/^[a-z0-9-]+$/.test(scope)) throw new Error("Invalid operation lock scope");
  if (scope.startsWith("task-")) {
    const legacy = join(directory, "locks", `${scope.slice(5)}.pid`);
    if (existsSync(legacy)) {
      const pid = Number(readFileSync(legacy, "utf8").trim());
      if (!Number.isSafeInteger(pid) || pid <= 0 || alive(pid))
        throw new Error("Legacy task operation is active");
    }
  }
  const root = join(directory, "operation-locks");
  mkdirSync(root, { recursive: true });
  return acquireDirectoryLock(join(root, scope));
}

export function acquireDirectoryLock(lock: string, beforeReap?: () => void): () => void {
  const token = `${process.pid} ${randomUUID()}`;
  const owner = join(lock, "owner");
  const create = () => {
    mkdirSync(lock);
    try {
      writeFileSync(owner, token, { flag: "wx" });
    } catch (error) {
      rmSync(lock, { recursive: true, force: true });
      throw error;
    }
  };
  try {
    create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Reapers serialize separately: a second stale-owner observer must not remove a fresh lock.
    const reap = `${lock}.reap`;
    mkdirSync(reap);
    try {
      const held = readFileSync(owner, "utf8");
      const pid = Number(held.split(" ")[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || alive(pid)) throw new Error("Operation busy");
      // A lease may publish an unknown-child marker just before its owner exits. Inspect it
      // under the reaper lock after proving the old owner dead, before deleting any evidence.
      beforeReap?.();
      rmSync(lock, { recursive: true });
      create();
    } finally {
      rmSync(reap, { recursive: true, force: true });
    }
  }
  return () => {
    if (existsSync(owner) && readFileSync(owner, "utf8") === token)
      rmSync(lock, { recursive: true });
  };
}
