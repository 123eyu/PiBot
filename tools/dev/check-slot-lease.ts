import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

export const checkSlotDirectory = join(tmpdir(), "pibot-dev-check-slots");

interface Owner {
  pid: number;
  started: number;
  token: string;
  workerPid?: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is not evidence that another user's process has stopped.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readOwner(file: string): Owner | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      Number.isFinite(value.started) &&
      typeof value.token === "string" &&
      (value.workerPid === undefined ||
        (Number.isSafeInteger(value.workerPid) && value.workerPid > 0))
    )
      return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return undefined;
}

function discardOwnerFile(file: string) {
  try {
    unlinkSync(file);
  } catch (error) {
    // Do not replace the original error or discard a successfully acquired lease.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn("check slots: could not remove lease metadata");
  }
}

function publishOwner(file: string, owner: Owner) {
  const temporary = join(checkSlotDirectory, `${owner.token}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    discardOwnerFile(temporary);
  }
}

export function inheritedCheckSlot(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { slot, token } = JSON.parse(value);
    if (!Number.isSafeInteger(slot) || slot < 0 || slot > 255 || !/^[a-f0-9-]{36}$/.test(token))
      return false;
    const owner = readOwner(join(checkSlotDirectory, `slot-${slot}`, `${token}.json`));
    return (
      !!owner &&
      owner.token === token &&
      (processAlive(owner.pid) || (!!owner.workerPid && processAlive(owner.workerPid)))
    );
  } catch {
    return false;
  }
}

function reclaim(directory: string) {
  try {
    let removed = false;
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const file = join(directory, name);
      const owner = readOwner(file);
      if (!owner || processAlive(owner.pid) || (owner.workerPid && processAlive(owner.workerPid)))
        continue;
      // Each lease has a unique filename. A competing reaper must not unlink a new owner's file.
      unlinkSync(file);
      removed = true;
    }
    // An owner may die between mkdir and publishing its record. Never recursively remove a slot.
    if (removed || Date.now() - statSync(directory).mtimeMs > 30_000) rmdirSync(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw error;
  }
}

function waitersAhead(owner: Owner): number {
  let ahead = 0;
  for (const name of readdirSync(checkSlotDirectory)) {
    if (!name.endsWith(".waiting.json")) continue;
    const file = join(checkSlotDirectory, name);
    const other = readOwner(file);
    if (!other) continue;
    if (!processAlive(other.pid)) {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else if (
      other.started < owner.started ||
      (other.started === owner.started && other.token < owner.token)
    )
      ahead++;
  }
  return ahead;
}

export async function acquireCheckSlot(signal: AbortSignal) {
  const raw = process.env.PIBOT_CHECK_SLOTS ?? "2";
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 256)
    throw new Error("PIBOT_CHECK_SLOTS must be an integer between 1 and 256");
  const limit = Number(raw);
  mkdirSync(checkSlotDirectory, { recursive: true, mode: 0o700 });
  const owner: Owner = { pid: process.pid, started: Date.now(), token: randomUUID() };
  const waiting = join(checkSlotDirectory, `${owner.token}.waiting.json`);
  publishOwner(waiting, owner);
  try {
    while (true) {
      signal.throwIfAborted();
      const ahead = waitersAhead(owner);
      // Only the first wave contends for mkdir; polling order is not a strict FIFO guarantee.
      for (let slot = 0; ahead < limit && slot < limit; slot++) {
        const directory = join(checkSlotDirectory, `slot-${slot}`);
        reclaim(directory);
        try {
          mkdirSync(directory, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        const identity = statSync(directory);
        const file = join(directory, `${owner.token}.json`);
        try {
          publishOwner(file, owner);
          const current = statSync(directory);
          // A reaper of an abandoned empty directory must not turn two mkdir winners into owners.
          if (identity.ino !== current.ino || identity.dev !== current.dev)
            throw new Error("check slot directory changed during acquisition");
        } catch (error) {
          discardOwnerFile(file);
          throw error;
        }
        let released = false;
        return {
          marker: JSON.stringify({ slot, token: owner.token }),
          worker(pid: number) {
            owner.workerPid = pid;
            publishOwner(file, owner);
          },
          release() {
            if (released) return;
            released = true;
            try {
              unlinkSync(file);
              rmdirSync(directory);
            } catch (error) {
              if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
                throw error;
            }
          },
        };
      }
      console.log(`等待检查空位（前面 ${limit + ahead} 个）`);
      await setTimeout(5_000, undefined, { signal });
    }
  } finally {
    discardOwnerFile(waiting);
  }
}
