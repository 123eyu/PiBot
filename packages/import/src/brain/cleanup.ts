// Resume private batch reclamation without making it part of the latency of a desktop RPC.
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { ImportStatus } from "@pibot/import-contract";
import type { ImportStore } from "../store/index.ts";

export class ImportCleanup {
  private work?: Promise<void>;
  private readonly blocked = new Set<string>();
  private readonly retries = new Set<string>();
  private requested = false;

  constructor(
    private readonly store: ImportStore,
    private readonly signal: AbortSignal,
    private readonly publish: (status: ImportStatus) => void,
    private readonly failed: () => void,
    private readonly restore: (id: string, signal: AbortSignal) => Promise<void>,
  ) {}

  idle() {
    return !this.work;
  }

  wake(retryId?: string) {
    if (this.signal.aborted) return;
    if (retryId) this.retries.add(retryId);
    this.requested = true;
    if (!this.work) {
      this.work = this.drainRequested().finally(() => {
        this.work = undefined;
        if (this.requested && !this.signal.aborted) void this.wake();
      });
      // SQLite failures keep their durable phase; project refusals stay scoped to their batch.
      void this.work.catch(this.failed);
    }
    return this.work;
  }

  wait() {
    return this.work;
  }

  private async drainRequested() {
    while (this.requested && !this.signal.aborted) {
      this.requested = false;
      for (const id of this.retries) this.blocked.delete(id);
      this.retries.clear();
      await this.drain();
    }
  }

  private async drain() {
    let last = -Infinity;
    let progressed: boolean;
    do {
      progressed = false;
      let cursor = 0;
      while (!this.signal.aborted) {
        await yieldToLoop();
        if (this.signal.aborted) return;
        const next = this.store.nextCleanup(cursor);
        if (!next) break;
        const { id } = next;
        if (this.blocked.has(id) || this.store.projects.hasDependents(id)) {
          cursor = next.cursor;
          continue;
        }
        try {
          await this.restore(id, this.signal);
        } catch {
          if (this.signal.aborted) return;
          // A fresh explicit retry can ask again; unrelated imports never repeat a refused card.
          this.blocked.add(id);
          this.failed();
          cursor = next.cursor;
          continue;
        }
        if (this.signal.aborted) return;
        const { status, done } = this.store.cleanupPage(id);
        progressed = true;
        if (done) cursor = next.cursor;
        if (done || (status.state === "undoing" && performance.now() - last >= 200)) {
          this.publish(status);
          last = done ? -Infinity : performance.now();
        }
      }
      // Restoring a later batch may have made an earlier dependent eligible in this pass.
    } while (progressed && !this.signal.aborted);
  }
}
