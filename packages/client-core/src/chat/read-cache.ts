import { ChatApprovalRouting } from "./approval-routing.ts";
import type { ChatPeer } from "./types.ts";

const scopeKey = Symbol("renderer chat reads");
const abortError = () => new DOMException("Read cancelled", "AbortError");
const isImage = (key: string) => key.startsWith("image-");
interface Lane {
  abort: AbortController;
  promise: Promise<unknown>;
  users: number;
  epoch: number;
  configEpoch: number;
}
// Events after which an in-flight read may already be stale (models, bots, topics, history…).
const configEvents = [
  "providers.changed",
  "bots.changed",
  "sidebar.changed",
  "permissions.changed",
] as const;
const messageEvents = [
  "chat.message",
  "chat.status",
  "chat.attachments",
  "chat.done",
  "chat.error",
] as const;
// Folder lists, Bot records and image model lists cannot change through chat traffic. Every
// other key (history, topics, topic busy state…) stays conservative and goes stale on any event,
// so a busy chat no longer splits concurrent directory reads into duplicate requests.
const configOnly = (key: string) =>
  key.startsWith('["workplaces",') || key.startsWith("bot:") || key.startsWith("images:");

/**
 * Shared, cancellable reads for one business Peer: concurrent consumers of a key share one
 * request, the last consumer leaving cancels it, and every read has a 30s deadline. Results are
 * not used as authority after completion; bounded label previews are kept separately for headers.
 * A read never joins a request issued before the latest change event, so a refresh triggered by
 * that event cannot receive pre-change data.
 */
export class ChatReadCache {
  readonly approvals: ChatApprovalRouting;
  private lanes = new Map<string, Lane>();
  private previews = new Map<string, { value: unknown; expires: number }>();
  private disposed = false;
  private disposers = new Set<() => void>();
  private epoch = 0;
  private configEpoch = 0;
  private off: (() => void)[];
  constructor(readonly peer: ChatPeer) {
    this.approvals = new ChatApprovalRouting(peer);
    // Created on first chat render, before controllers and hooks subscribe, so this listener runs
    // ahead of any refresh the same event triggers.
    this.off = [
      ...configEvents.map((event) =>
        peer.on(event, () => {
          if (event === "permissions.changed" || event === "bots.changed") this.previews.clear();
          this.epoch++;
          this.configEpoch++;
        }),
      ),
      ...messageEvents.map((event) =>
        peer.on(event, () => {
          this.epoch++;
        }),
      ),
    ];
  }
  /** Display-only: a previous label must never certify fresh permissions or directory bindings. */
  preview<T>(key: string): T | undefined {
    const item = this.previews.get(key);
    if (!item || item.expires <= performance.now() || this.disposed) {
      this.previews.delete(key);
      return;
    }
    return item.value as T;
  }
  rememberPreview(key: string, value: unknown) {
    if (this.disposed || JSON.stringify(value).length > 128_000) return;
    this.previews.delete(key);
    this.previews.set(key, { value, expires: performance.now() + 300_000 });
    while (this.previews.size > 32)
      this.previews.delete(this.previews.keys().next().value as string);
  }
  isDisposed() {
    return this.disposed;
  }
  onDispose(fn: () => void) {
    if (this.disposed) {
      fn();
      return () => {};
    }
    this.disposers.add(fn);
    return () => {
      this.disposers.delete(fn);
    };
  }
  async read<T>(
    key: string,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.disposed) throw abortError();
    let lane = this.lanes.get(key);
    // Image keys name immutable content, so change events never make their reads stale.
    const stale =
      !!lane &&
      !isImage(key) &&
      (configOnly(key) ? lane.configEpoch !== this.configEpoch : lane.epoch !== this.epoch);
    if (!lane || lane.abort.signal.aborted || stale) {
      // Reject rather than silently growing an unbounded queue of abandoned mounts. Image reads
      // are excluded: they hold a lane while queueing for ImagePreviewCache's own bounded slots,
      // and a screen of pictures must not starve history or directory reads.
      if (!lane && !isImage(key) && this.chatLanes() >= 16)
        throw new Error("Read capacity reached");
      // A remount/invalidation often re-reads the key its cleanup just cancelled. Queue behind
      // the stopping read instead of failing, so the same key never has two requests in flight.
      // A stale lane keeps serving its existing users and is simply no longer joinable.
      const stopping = (lane?.abort.signal.aborted ? lane : undefined)?.promise.then(
        () => {},
        () => {},
      );
      const abort = new AbortController();
      // Image reads queue for ImagePreviewCache's slots inside the lane and set their own deadline.
      const timer = isImage(key) ? undefined : setTimeout(() => abort.abort(), 30_000);
      const promise = (stopping ?? Promise.resolve())
        .then(() => {
          abort.signal.throwIfAborted();
          return operation(abort.signal);
        })
        .finally(() => {
          clearTimeout(timer);
          if (this.lanes.get(key)?.promise === promise) this.lanes.delete(key);
        });
      lane = { abort, promise, users: 0, epoch: this.epoch, configEpoch: this.configEpoch };
      this.lanes.set(key, lane);
    }
    const current = lane;
    current.users++;
    return new Promise<T>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal.removeEventListener("abort", cancel);
        current.abort.signal.removeEventListener("abort", cancel);
        if (--current.users === 0) current.abort.abort();
      };
      const cancel = () => {
        release();
        reject(abortError());
      };
      signal.addEventListener("abort", cancel, { once: true });
      current.abort.signal.addEventListener("abort", cancel, { once: true });
      current.promise.then(
        (value) => {
          if (!released) {
            release();
            resolve(value as T);
          }
        },
        (error) => {
          if (!released) {
            release();
            reject(error);
          }
        },
      );
    });
  }
  reading(key: string) {
    return (this.lanes.get(key)?.users ?? 0) > 0;
  }
  cancel(key: string) {
    this.lanes.get(key)?.abort.abort();
  }
  cancelImages() {
    for (const [key, lane] of this.lanes) if (isImage(key)) lane.abort.abort();
  }
  private chatLanes() {
    let count = 0;
    for (const key of this.lanes.keys()) if (!isImage(key)) count++;
    return count;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.approvals.dispose();
    this.previews.clear();
    for (const dispose of this.disposers) dispose();
    this.disposers.clear();
    for (const unsubscribe of this.off) unsubscribe();
    this.off = [];
    for (const lane of this.lanes.values()) lane.abort.abort();
  }
}

export function chatReadCache(peer: ChatPeer): ChatReadCache {
  const owner = peer as ChatPeer & { [scopeKey]?: ChatReadCache };
  if (!owner[scopeKey]) owner[scopeKey] = new ChatReadCache(peer);
  return owner[scopeKey];
}
export function disposeChatReads(peer: ChatPeer) {
  const owner = peer as ChatPeer & { [scopeKey]?: ChatReadCache };
  owner[scopeKey]?.dispose();
  // Keep the empty tombstone while a disconnected viewport still holds this old Peer.
}
