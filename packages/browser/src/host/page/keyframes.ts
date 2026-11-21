import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cdp } from "../cdp.ts";

/** Wait for the page to show the result of the action (and for typing to pause) before a shot. */
const SETTLE_MS = 500;
const MAX_SHOTS = 500;
const WIDTH = 480;
/** Below the 64 KB thumbnail cap, so brain can hand the file to the window as it is. */
const MAX_BYTES = 60 * 1024;
const CAPTURE_TIMEOUT_MS = 3000;

/**
 * Small page keyframes for the "teach it once" step list. Written straight into the
 * recording's folder by this process, so no image ever crosses an RPC channel; brain only reads
 * the files it needs. Bursts (typing) collapse into one shot of the latest event; one capture at
 * a time. Owner: the BotBrowser while recording; `finish()` flushes, `dispose()` drops.
 */
export class Keyframes {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: number | undefined;
  private running: Promise<void> | undefined;
  private written = 0;
  private disposed = false;

  constructor(
    private readonly dir: string,
    private readonly target: () => Cdp | undefined,
    private readonly shrink: Shrink,
    private readonly warn: (message: string) => void,
  ) {}

  note(index: number) {
    if (this.disposed) return;
    this.pending = index;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SETTLE_MS);
  }

  private flush(): Promise<void> {
    this.timer = undefined;
    if (this.running) return this.running;
    const index = this.pending;
    this.pending = undefined;
    if (index === undefined || this.disposed || this.written >= MAX_SHOTS) return Promise.resolve();
    this.running = this.shoot(index).finally(() => {
      this.running = undefined;
      // An event that arrived during the capture gets its own (later) shot.
      if (this.pending !== undefined && !this.disposed && !this.timer)
        this.timer = setTimeout(() => void this.flush(), SETTLE_MS);
    });
    return this.running;
  }

  private async shoot(index: number) {
    const cdp = this.target();
    if (!cdp) return;
    try {
      const data = await capture(cdp, this.shrink);
      if (!data || this.disposed) return;
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFile(join(this.dir, `e${index}.jpg`), data, { mode: 0o600 });
      this.written++;
    } catch {
      // A page mid-navigation may never answer captureScreenshot; the step just has no picture.
      this.warn("teach keyframe skipped");
    }
  }

  /** Pause: a shot still waiting would show what the user does while paused. */
  drop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  /** Stop: the last action still gets its shot, bounded by the capture timeout. */
  async finish() {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending !== undefined) await this.flush();
    this.dispose();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Downscales a JPEG to `width` and re-encodes it at `quality`; see BrowserPlatform.thumbnail. */
export type Shrink = (data: Buffer, width: number, quality: number) => Buffer | undefined;

/**
 * The visible viewport as is, shrunk here. A `clip` (needed for CDP's own `scale`) makes
 * Chromium emulate a smaller device for the length of the capture, and the overlay screencasts
 * that very page: it showed a 480-wide frame, the page in a corner on grey (clicks then mapped
 * into the wrong space), and a capture left hanging by a navigation kept the view blank.
 */
async function capture(cdp: Cdp, shrink: Shrink) {
  const { data } = await cdp.send<{ data: string }>(
    "Page.captureScreenshot",
    { format: "jpeg", quality: 80 },
    CAPTURE_TIMEOUT_MS,
  );
  const full = Buffer.from(data, "base64");
  for (const quality of [55, 35]) {
    const bytes = shrink(full, WIDTH, quality);
    if (bytes && bytes.length <= MAX_BYTES) return bytes;
  }
  return undefined;
}
