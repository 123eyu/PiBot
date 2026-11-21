import type { Peer } from "@pibot/renderer-kit";

const MAX_ENTRIES = 150;
const MAX_ACTIVE = 4;

/**
 * Step thumbnails are small (protocol THUMBNAIL_BYTES) and immutable per step, so a bounded LRU
 * keyed by step ID is enough. Reads are lazy (only visible rows ask) and at most four run at once
 * so scrolling a long log cannot flood the business RPC queue with screenshot reads.
 */
class ThumbnailCache {
  private entries = new Map<string, string>();
  private inflight = new Map<string, Promise<string>>();
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly peer: Peer) {}
  cached(stepId: string) {
    const source = this.entries.get(stepId);
    if (source !== undefined) {
      this.entries.delete(stepId);
      this.entries.set(stepId, source);
    }
    return source;
  }
  load(stepId: string): Promise<string> {
    const cached = this.cached(stepId);
    if (cached !== undefined) return Promise.resolve(cached);
    let pending = this.inflight.get(stepId);
    if (!pending) {
      pending = this.slot()
        .then(() => this.peer.call("computer.screenshot.thumbnail", { stepId }))
        .then((image) => {
          const source = `data:${image.mimeType};base64,${image.data}`;
          this.entries.set(stepId, source);
          while (this.entries.size > MAX_ENTRIES) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
          }
          return source;
        })
        .finally(() => {
          this.inflight.delete(stepId);
          this.release();
        });
      this.inflight.set(stepId, pending);
    }
    return pending;
  }
  private slot() {
    if (this.active < MAX_ACTIVE) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }
  private release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

const caches = new WeakMap<Peer, ThumbnailCache>();
export function thumbnailCache(peer: Peer) {
  let cache = caches.get(peer);
  if (!cache) {
    cache = new ThumbnailCache(peer);
    caches.set(peer, cache);
  }
  return cache;
}
