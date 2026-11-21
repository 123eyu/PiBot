import type { ChatPeer } from "@pibot/client-core";
import { type ChatReadCache, chatReadCache } from "@pibot/client-core";
import {
  type Attachment,
  type EventPayloads,
  type MethodResults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";

const ownerKey = Symbol("visible image previews");
export const imageKey = (attachment: Attachment) => JSON.stringify(attachment);
async function thumbnail(image: MethodResults["chat.attachment"], signal: AbortSignal) {
  signal.throwIfAborted();
  const blob = await new Promise<Blob>((resolve, reject) => {
    const worker = new Worker(new URL("./image-preview-worker.ts", import.meta.url), {
      type: "module",
    });
    const finish = () => {
      signal.removeEventListener("abort", cancel);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    const cancel = () => {
      finish();
      reject(new Error("Image preview cancelled"));
    };
    worker.onmessage = ({ data }: MessageEvent<{ blob?: Blob; error?: true }>) => {
      finish();
      if (data.blob instanceof Blob && data.blob.size <= 96 * 1024) resolve(data.blob);
      else reject(new Error("Image preview unavailable"));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish();
      reject(new Error("Image preview unavailable"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      worker.postMessage(image);
    } catch {
      finish();
      reject(new Error("Image preview unavailable"));
    }
  });
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const cancel = () => reader.abort();
    const finish = () => signal.removeEventListener("abort", cancel);
    reader.onload = () => {
      finish();
      resolve(String(reader.result));
    };
    reader.onerror = reader.onabort = () => {
      finish();
      reject(new Error("Image preview cancelled"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    reader.readAsDataURL(blob);
  });
}

/** Previews only; full-resolution responses are never retained by this cache. */
export class ImagePreviewCache {
  private entries = new Map<string, { source: string; expires: number }>();
  private active = 0;
  private waiters = new Set<() => void>();
  private disposed = false;
  private revision = 0;
  private generation = 0;
  private boundary = 0;
  private identities = new Map<string, { id: string; owners: Set<string>; version: number }>();
  private listeners = new Map<string, Set<() => void>>();
  private off: (() => void)[];
  constructor(private readonly reads: ChatReadCache) {
    if (reads.isDisposed()) {
      this.disposed = true;
      this.off = [];
      return;
    }
    this.off = [
      reads.peer.on("chat.attachments", (event) => this.attachmentsChanged(event)),
      reads.peer.on("permissions.changed", () => this.clear()),
      reads.onDispose(() => this.dispose()),
    ];
  }
  version = () => this.revision;
  authorityVersion(attachment: Attachment) {
    return this.identities.get(imageKey(attachment))?.version ?? this.boundary;
  }
  private identity(attachment: Attachment, messageId?: string) {
    const key = imageKey(attachment);
    let identity = this.identities.get(key);
    if (!identity)
      identity = { id: attachment.id, owners: new Set<string>(), version: this.boundary };
    if (messageId) {
      identity.owners.delete(messageId);
      identity.owners.add(messageId);
      if (identity.owners.size > 128)
        identity.owners.delete(identity.owners.values().next().value as string);
    }
    this.identities.delete(key);
    this.identities.set(key, identity);
    if (this.identities.size > 64)
      for (const [old] of this.identities) {
        if (
          old !== key &&
          !this.entries.has(old) &&
          !this.reads.reading(`image-preview:${old}`) &&
          !this.reads.reading(`image-original:${old}`)
        ) {
          this.identities.delete(old);
          if (this.identities.size <= 64) break;
        }
      }
    return identity;
  }
  private attachmentsChanged(event: EventPayloads["chat.attachments"]) {
    const next = new Map(
      event.attachments.map((attachment) => [attachment.id, imageKey(attachment)]),
    );
    for (const [key, identity] of this.identities) {
      const replacement = next.get(identity.id);
      if (
        (replacement && replacement !== key) ||
        (identity.owners.has(event.messageId) && !replacement)
      )
        this.invalidateKey(key);
    }
  }
  reading(attachment: Attachment) {
    return this.reads.reading(`image-preview:${imageKey(attachment)}`);
  }
  /** Notifies only the previews whose key changed; a screen of images must not re-render N×N. */
  private changed(keys?: Iterable<string>) {
    this.revision++;
    if (!keys) {
      for (const set of this.listeners.values()) for (const fn of set) fn();
      return;
    }
    for (const key of keys) for (const fn of this.listeners.get(key) ?? []) fn();
  }
  subscribe(key: string, fn: () => void) {
    if (this.disposed) return () => {};
    const set = this.listeners.get(key) ?? new Set<() => void>();
    this.listeners.set(key, set);
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size && this.listeners.get(key) === set) this.listeners.delete(key);
    };
  }
  private clear() {
    this.reads.cancelImages();
    this.entries.clear();
    this.boundary = ++this.generation;
    this.identities.clear();
    this.changed();
  }
  get(attachment: Attachment, messageId?: string, visible = false) {
    const key = imageKey(attachment),
      entry = this.entries.get(key);
    if (!entry) return;
    if ((!visible && entry.expires <= Date.now()) || this.disposed) {
      this.entries.delete(key);
      return;
    }
    // An immutable preview already on screen is still in use; expiry applies to idle reuse.
    if (visible) entry.expires = Date.now() + 120_000;
    this.identity(attachment, messageId);
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.source;
  }
  invalidate(attachment: Attachment) {
    this.invalidateKey(imageKey(attachment));
  }
  private invalidateKey(key: string) {
    const identity = this.identities.get(key);
    if (identity) identity.version = ++this.generation;
    this.entries.delete(key);
    this.reads.cancel(`image-preview:${key}`);
    this.reads.cancel(`image-original:${key}`);
    this.changed([key]);
  }
  private async slot(signal: AbortSignal) {
    while (this.active >= 2) {
      signal.throwIfAborted();
      if (this.waiters.size >= 32) throw new Error("Image read capacity reached");
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          this.waiters.delete(ready);
          signal.removeEventListener("abort", cancel);
        };
        const ready = () => {
          finish();
          resolve();
        };
        const cancel = () => {
          finish();
          reject(new Error("Image read cancelled"));
        };
        this.waiters.add(ready);
        signal.addEventListener("abort", cancel, { once: true });
      });
    }
    signal.throwIfAborted();
    if (this.disposed) throw new Error("Image cache disposed");
    this.active++;
    return () => {
      this.active--;
      for (const ready of this.waiters) ready();
    };
  }
  async original(attachment: Attachment, signal: AbortSignal, messageId?: string) {
    const identity = this.identity(attachment, messageId);
    const key = imageKey(attachment);
    return this.reads.read(
      `image-original:${imageKey(attachment)}`,
      async (queued) => {
        const release = await this.slot(queued);
        // Image lanes have no lane deadline: waiting for a slot is not part of the read's budget.
        const read = AbortSignal.any([queued, AbortSignal.timeout(30_000)]);
        try {
          const version = identity.version;
          const image = await this.reads.peer.call(
            "chat.attachment",
            { id: attachment.id },
            { signal: read },
          );
          read.throwIfAborted();
          if (
            identity !== this.identities.get(key) ||
            version !== identity.version ||
            this.disposed
          )
            throw new Error("Attachment changed");
          return image;
        } finally {
          // A failed or cancelled read does not change the attachment, so it must not evict the
          // preview or bump the version (that re-ran the effects and retried without limit).
          release();
        }
      },
      signal,
    );
  }
  /**
   * The brain returns a small cached thumbnail, so the UI thread never receives, validates or
   * decodes the full image just to show it. Older brains fall back to the local worker path.
   */
  private async thumbnailSource(id: string, signal: AbortSignal) {
    if (!this.legacyPreview)
      try {
        const image = await this.reads.peer.call("chat.attachmentPreview", { id }, { signal });
        return `data:${image.mimeType};base64,${image.data}`;
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== RpcErrorCodes.methodNotFound)
          throw error;
        this.legacyPreview = true;
      }
    const image = await this.reads.peer.call("chat.attachment", { id }, { signal });
    return thumbnail(image, signal);
  }
  private legacyPreview = false;
  async preview(attachment: Attachment, signal: AbortSignal, messageId?: string) {
    const identity = this.identity(attachment, messageId);
    const key = imageKey(attachment);
    const cached = this.get(attachment, messageId);
    if (cached) return cached;
    return this.reads.read(
      `image-preview:${imageKey(attachment)}`,
      async (queued) => {
        this.changed([key]);
        // The same two slots bound RPC responses and off-thread decoding together.
        const release = await this.slot(queued);
        const read = AbortSignal.any([queued, AbortSignal.timeout(30_000)]);
        try {
          const version = identity.version;
          const source = await this.thumbnailSource(attachment.id, read);
          read.throwIfAborted();
          if (
            this.disposed ||
            identity !== this.identities.get(key) ||
            version !== identity.version
          )
            throw new Error("Image cache changed");
          if (source.length * 2 > 256 * 1024) throw new Error("Image preview budget exceeded");
          this.entries.set(key, { source, expires: Date.now() + 120_000 });
          const touched = [key];
          let bytes = 0;
          for (const entry of this.entries.values()) bytes += entry.source.length * 2;
          while (this.entries.size > 32 || bytes > 4 * 1024 * 1024) {
            const oldest = this.entries.entries().next().value;
            if (!oldest) break;
            bytes -= oldest[1].source.length * 2;
            this.entries.delete(oldest[0]);
            touched.push(oldest[0]);
          }
          this.changed(touched);
          return source;
        } finally {
          release();
        }
      },
      signal,
    );
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.listeners.clear();
    for (const off of this.off) off();
    this.off = [];
    for (const ready of this.waiters) ready();
  }
}
export function imagePreviewCache(peer: ChatPeer) {
  const owner = peer as ChatPeer & { [ownerKey]?: ImagePreviewCache };
  if (!owner[ownerKey]) owner[ownerKey] = new ImagePreviewCache(chatReadCache(peer));
  return owner[ownerKey];
}
