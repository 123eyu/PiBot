import type { DatabaseSync } from "node:sqlite";
import { writeMemoryUsage } from "@pibot/storage";

/** Each capability owns a bounded buffer; repeated context refreshes count once per flush window. */
export class MemoryUsage {
  private readonly pending = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly onError: () => void,
  ) {}

  record(ids: readonly string[]) {
    if (this.stopped) return;
    const at = new Date().toISOString();
    for (const id of ids) {
      if (this.pending.size >= 1000 && !this.pending.has(id)) this.flush();
      this.pending.set(id, at);
    }
    if (this.pending.size && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        try {
          this.flush();
        } catch {
          // Keep the bounded buffer for the next operation/stop; never log SQLite content.
          this.onError();
        }
      }, 30_000);
      this.timer.unref();
    }
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.size) return;
    writeMemoryUsage(this.db, this.pending);
    this.pending.clear();
  }

  stop() {
    this.stopped = true;
    this.flush();
  }
}
