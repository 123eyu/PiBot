import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Ordinary writes only update the counter; only Office admission may scan or refuse a write. */
export class SnapshotBudget {
  private total?: number;
  private loading?: Promise<void>;
  private delta = 0;
  constructor(private readonly dataDir: string) {}
  added(bytes: number) {
    if (this.total === undefined) this.delta += bytes;
    else this.total += bytes;
  }
  invalidate() {
    this.total = undefined;
    this.delta = 0;
  }
  async admit(bytes: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.total === undefined) {
      if (!this.loading) this.delta = 0;
      this.loading ??= this.scan(signal)
        .then((bytes) => {
          // Concurrent ordinary writes never wait for the scan. Counting them twice is conservative.
          this.total = bytes + this.delta;
          this.delta = 0;
        })
        .finally(() => {
          this.loading = undefined;
        });
      await this.loading;
    }
    signal.throwIfAborted();
    if ((this.total ?? 0) + bytes > 2 * 1024 * 1024 * 1024)
      throw new Error("office_checkpoint_unavailable");
  }
  private async scan(signal: AbortSignal) {
    let bytes = 0,
      entries = 0;
    const list = (path: string) =>
      readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    const visit = async (directory: string) => {
      for (const entry of await list(directory)) {
        signal.throwIfAborted();
        if (++entries > 100_000) throw new Error("office_checkpoint_unavailable");
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) bytes += (await stat(path)).size;
      }
    };
    for (const bot of await list(join(this.dataDir, "bots"))) {
      if (!bot.isDirectory() || !/^[0-9a-f-]{36}$/.test(bot.name)) continue;
      for (const kind of ["changes", "file-checkpoints"])
        await visit(join(this.dataDir, "bots", bot.name, kind));
    }
    return bytes;
  }
}
