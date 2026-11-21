import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Logger } from "@pibot/observability";
import { containsPath } from "@pibot/policy";

/** One writer per folder; ten minutes covers a long build without hanging a run. */
export const FOLDER_LOCK_WAIT_MS = 10 * 60 * 1000;

export interface WriteLockOwner {
  runId: string;
  botId: string;
  /**
   * Identifies one tool-run instance of the run: a parked routine resumes under the same run id,
   * and the old instance's late release must not drop the new instance's hold.
   */
  lease?: string;
}
export class FolderLockError extends Error {
  constructor(
    readonly code: "timeout" | "deadlock" | "stopped",
    readonly holder?: WriteLockOwner,
  ) {
    super(`folder_lock_${code}`);
    this.name = "FolderLockError";
  }
}
/** Text for the model when a write could not get the folder (bilingual like other tool errors). */
export function folderLockText(error: FolderLockError) {
  return error.code === "stopped"
    ? "已停止 / Stopped"
    : "另一个 Bot 正在改这个文件夹，请稍后再试或先做别的 / Another Bot is changing this folder; try again later or do something else first";
}

interface Entry {
  /** Held until the run ends (release(runId)). */
  pinned: boolean;
  /** Short holds (one image save) that end on their own. */
  scoped: number;
}
interface Hold {
  owner: WriteLockOwner;
  lease?: string;
  keys: Map<string, Entry>;
}
interface Waiter {
  owner: WriteLockOwner;
  keys: string[];
  holder: string;
  onWait?(holder: WriteLockOwner): void;
  grant(): void;
  fail(error: Error): void;
}
export interface FolderWriteLocksDeps {
  platform: "darwin" | "linux" | "win32";
  logger: Logger;
  waitMs?: number;
}

/**
 * Per-folder write lock shared by every run of this brain (private chats, groups, routines): a
 * folder is identified by its real path, and two folders conflict when one contains the other,
 * so a private chat and a group using the same (or a nested) folder also take turns. Reads never
 * lock. A run's lock is reentrant and is held from its first write until release(runId) at the end
 * of the run (finish, cancel, error, parking or brain stop), which keeps the run's "this turn"
 * command watch inside the period where it is the only writer.
 */
export class FolderWriteLocks {
  private readonly holds = new Map<string, Hold>();
  private waiters: Waiter[] = [];
  private stopped = false;
  constructor(private readonly deps: FolderWriteLocksDeps) {}

  /** Holds `roots` for the rest of the run; resolves at once when this run already holds them. */
  async acquire(
    owner: WriteLockOwner,
    roots: readonly string[],
    signal: AbortSignal,
    onWait?: (holder: WriteLockOwner) => void,
  ) {
    await this.take(owner, await this.keys(roots), true, signal, onWait);
  }

  /** Holds `roots` only while `operation` runs (a write that is not part of a tool run's turn). */
  async withLock<T>(
    owner: WriteLockOwner,
    roots: readonly string[],
    signal: AbortSignal,
    operation: () => Promise<T>,
    onWait?: (holder: WriteLockOwner) => void,
  ): Promise<T> {
    const keys = await this.keys(roots);
    await this.take(owner, keys, false, signal, onWait);
    try {
      return await operation();
    } finally {
      this.releaseScoped(owner.runId, keys);
    }
  }

  async isHeld(runId: string, roots: readonly string[]) {
    const hold = this.holds.get(runId);
    if (!hold) return false;
    const keys = await this.keys(roots);
    return keys.every((key) =>
      [...hold.keys.keys()].some((held) => containsPath(held, key, this.deps.platform)),
    );
  }

  /** A resumed instance with the same run id must not inherit an old instance proof. */
  assertOwner(owner: Readonly<WriteLockOwner>): void {
    const hold = this.holds.get(owner.runId);
    if (
      this.stopped ||
      !owner.lease ||
      hold?.owner.botId !== owner.botId ||
      hold.lease !== owner.lease ||
      !hold.keys.size
    )
      throw new FolderLockError("stopped");
  }

  /** Management actions must fail fast instead of waiting on their own active tool run. */
  async overlapsHeld(runId: string, roots: readonly string[]) {
    const hold = this.holds.get(runId);
    if (!hold) return false;
    const keys = await this.keys(roots);
    return [...hold.keys.keys()].some((held) => keys.some((key) => this.overlaps(held, key)));
  }

  /** Ends every hold of a run (of that lease, when given); idempotent. */
  release(runId: string, lease?: string) {
    const hold = this.holds.get(runId);
    if (!hold || (lease && hold.lease && hold.lease !== lease)) return;
    this.holds.delete(runId);
    this.wake();
  }

  dispose() {
    this.stopped = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.fail(new FolderLockError("stopped"));
    this.holds.clear();
  }

  private async keys(roots: readonly string[]) {
    const keys = await Promise.all(
      roots.map(async (root) => {
        // A folder that cannot be resolved right now still locks under its spelled path.
        const real = await realpath(root).catch(() => resolve(root));
        // macOS and Windows volumes are case-insensitive by default; folding can only over-lock.
        return this.deps.platform === "linux" ? real : real.toLowerCase();
      }),
    );
    return [...new Set(keys)];
  }

  private overlaps(a: string, b: string) {
    return containsPath(a, b, this.deps.platform) || containsPath(b, a, this.deps.platform);
  }

  /** Another run's hold that conflicts with `keys`. Holds are few (one per active writer). */
  private blocker(runId: string, keys: readonly string[]) {
    for (const hold of this.holds.values()) {
      if (hold.owner.runId === runId) continue;
      for (const held of hold.keys.keys())
        if (keys.some((key) => this.overlaps(held, key))) return hold;
    }
    return undefined;
  }

  /** Whether waiting on `blocking` would wait (transitively) on `runId` itself. */
  private cycle(runId: string, blocking: Hold) {
    const seen = new Set<string>();
    let current: Hold | undefined = blocking;
    while (current && !seen.has(current.owner.runId)) {
      if (current.owner.runId === runId) return true;
      seen.add(current.owner.runId);
      const waiting = this.waiters.find((waiter) => waiter.owner.runId === current?.owner.runId);
      current = waiting ? this.blocker(waiting.owner.runId, waiting.keys) : undefined;
    }
    return false;
  }

  private grant(owner: WriteLockOwner, keys: readonly string[], pinned: boolean) {
    let hold = this.holds.get(owner.runId);
    if (!hold) {
      hold = { owner, keys: new Map() };
      this.holds.set(owner.runId, hold);
    }
    if (pinned && owner.lease) hold.lease = owner.lease;
    for (const key of keys) {
      const entry = hold.keys.get(key) ?? { pinned: false, scoped: 0 };
      if (pinned) entry.pinned = true;
      else entry.scoped++;
      hold.keys.set(key, entry);
    }
  }

  private releaseScoped(runId: string, keys: readonly string[]) {
    const hold = this.holds.get(runId);
    if (!hold) return;
    for (const key of keys) {
      const entry = hold.keys.get(key);
      if (!entry) continue;
      entry.scoped = Math.max(0, entry.scoped - 1);
      if (!entry.pinned && entry.scoped === 0) hold.keys.delete(key);
    }
    if (!hold.keys.size) this.holds.delete(runId);
    this.wake();
  }

  private async take(
    owner: WriteLockOwner,
    keys: string[],
    pinned: boolean,
    signal: AbortSignal,
    onWait?: (holder: WriteLockOwner) => void,
  ) {
    if (this.stopped) throw new FolderLockError("stopped");
    signal.throwIfAborted();
    const blocking = this.blocker(owner.runId, keys);
    if (!blocking) {
      this.grant(owner, keys, pinned);
      return;
    }
    if (this.cycle(owner.runId, blocking)) throw new FolderLockError("deadlock", blocking.owner);
    const started = Date.now();
    await new Promise<void>((accept, reject) => {
      const waiter: Waiter = {
        owner,
        keys,
        holder: blocking.owner.runId,
        ...(onWait ? { onWait } : {}),
        grant: () => {
          cleanup();
          this.grant(owner, keys, pinned);
          accept();
        },
        fail: (error) => {
          cleanup();
          reject(error);
        },
      };
      const remove = () => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
      };
      const abort = () => {
        remove();
        waiter.fail(signal.reason);
      };
      const timer = setTimeout(() => {
        remove();
        const holder = this.holds.get(waiter.holder)?.owner;
        this.deps.logger.warn(
          `Folder write lock wait timed out bot=${owner.botId} run=${owner.runId} holderBot=${holder?.botId ?? "unknown"} holderRun=${waiter.holder} waitedMs=${Date.now() - started}`,
        );
        waiter.fail(new FolderLockError("timeout", holder));
      }, this.deps.waitMs ?? FOLDER_LOCK_WAIT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
      onWait?.(blocking.owner);
    });
  }

  /** Grants waiters in arrival order; a waiter whose blocker changed is told who it waits for now. */
  private wake() {
    for (const waiter of [...this.waiters]) {
      if (!this.waiters.includes(waiter)) continue;
      const blocking = this.blocker(waiter.owner.runId, waiter.keys);
      if (!blocking) {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        waiter.grant();
        continue;
      }
      if (blocking.owner.runId === waiter.holder) continue;
      waiter.holder = blocking.owner.runId;
      if (this.cycle(waiter.owner.runId, blocking)) {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        waiter.fail(new FolderLockError("deadlock", blocking.owner));
        continue;
      }
      waiter.onWait?.(blocking.owner);
    }
  }
}
