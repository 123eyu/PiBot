// Resume private batch reclamation without making it part of the latency of a desktop RPC.
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { ImportStatus } from "@pibot/import-contract";
import type { ImportStore } from "../store/index.ts";

export class ImportCleanup {
  private work?: Promise<void>;

  constructor(
    private readonly store: ImportStore,
    private readonly signal: AbortSignal,
    private readonly publish: (status: ImportStatus) => void,
    private readonly failed: () => void,
  ) {}

  idle() {
    return !this.work;
  }

  wake() {
    if (this.signal.aborted) return;
    if (!this.work) {
      this.work = this.drain().finally(() => {
        this.work = undefined;
      });
      // The durable phase stays pending if SQLite fails; a repeat request or restart can resume.
      void this.work.catch(this.failed);
    }
    return this.work;
  }

  wait() {
    return this.work;
  }

  private async drain() {
    let last = -Infinity;
    while (!this.signal.aborted) {
      await yieldToLoop();
      if (this.signal.aborted) return;
      const id = this.store.nextCleanup();
      if (!id) return;
      const { status, done } = this.store.cleanupPage(id);
      if (done || (status.state === "undoing" && performance.now() - last >= 200)) {
        this.publish(status);
        last = done ? -Infinity : performance.now();
      }
    }
  }
}
