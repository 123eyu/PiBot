import { constants } from "node:fs";
import { type FileHandle, open, rename } from "node:fs/promises";

/** Each background log file stays under this size; one previous file is kept (`.1`). */
const FILE_LIMIT = 1024 * 1024;
/** Above this many queued bytes the producer is asked to pause its pipes. */
const HIGH_WATER = 256 * 1024;

const CREATE =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_NOFOLLOW;

/**
 * Size-bounded, rotating log for a long-running background command. Files are always
 * created fresh (O_EXCL + O_NOFOLLOW) inside the Bot-writable home, so a planted link or file is
 * never appended to; a failed write or rotation only stops disk logging, never the process.
 */
export class RollingLog {
  private chain = Promise.resolve();
  private pending = 0;
  private size = 0;
  private failed = false;
  private closed = false;
  private closing?: Promise<void>;

  private constructor(
    readonly path: string,
    private file: FileHandle | undefined,
    private readonly onDrain: () => void,
    private readonly onFailure: () => void,
  ) {}

  static async create(path: string, onDrain: () => void, onFailure: () => void) {
    return new RollingLog(path, await open(path, CREATE, 0o600), onDrain, onFailure);
  }

  /** Queues `text`; false means "pause the producer until onDrain". */
  write(text: string): boolean {
    if (this.failed || this.closed || !text) return true;
    const data = Buffer.from(text, "utf8");
    this.pending += data.length;
    this.chain = this.chain.then(async () => {
      try {
        if (this.failed || !this.file) return;
        for (let offset = 0; offset < data.length; ) {
          let end = Math.min(data.length, offset + 64 * 1024);
          // Rotate only between complete UTF-8 characters, even for a huge single write.
          while (end < data.length && ((data[end] ?? 0) & 0xc0) === 0x80) end--;
          const chunk = data.subarray(offset, end);
          if (this.size > 0 && this.size + chunk.length > FILE_LIMIT) await this.rotate();
          await this.file?.writeFile(chunk);
          this.size += chunk.length;
          offset = end;
        }
      } catch {
        this.fail();
      } finally {
        const before = this.pending;
        this.pending -= data.length;
        if (before > HIGH_WATER && this.pending <= HIGH_WATER) this.onDrain();
      }
    });
    return this.pending <= HIGH_WATER;
  }

  private async rotate() {
    const file = this.file;
    this.file = undefined;
    await file?.close();
    await rename(this.path, `${this.path}.1`);
    this.file = await open(this.path, CREATE, 0o600);
    this.size = 0;
  }

  private fail() {
    if (this.failed) return;
    this.failed = true;
    this.onFailure();
  }

  close() {
    this.closing ??= this.closeFile();
    return this.closing;
  }

  private async closeFile() {
    this.closed = true;
    await this.chain;
    const file = this.file;
    this.file = undefined;
    try {
      await file?.close();
    } catch {
      // Closing an already failed handle has nothing left to flush.
    }
  }
}
