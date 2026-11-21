import { z } from "zod";
import type { LocalData } from "./types.ts";

/** Private blob storage (expo-file-system in the app, memory in the dev probes). */
export interface BlobFiles {
  /** Appends to a blob, creating it and its folder on the first write. */
  append(name: string, chunk: string, encoding: "utf8" | "base64"): Promise<void>;
  readText(name: string): Promise<string>;
  /** A file:// address for native views such as images. */
  uri(name: string): string;
  /** Size in bytes; null when the blob is gone (the OS may purge caches). */
  size(name: string): number | null;
  remove(name: string): void;
  /** Removes a computer's whole folder. */
  removeFolder(folder: string): void;
}
const EntrySchema = z.strictObject({
  key: z.string().min(1).max(10_000),
  revision: z.string().min(1).max(200),
  kind: z.string().min(1).max(40),
  blob: z.string().min(1).max(200),
  bytes: z.number().int().nonnegative(),
  usedAt: z.number().int().nonnegative(),
});
const IndexSchema = z.array(EntrySchema).max(5000);
export type CacheEntry = z.infer<typeof EntrySchema>;
export interface CacheWriter {
  append(chunk: string, encoding: "utf8" | "base64"): Promise<void>;
  commit(revision: string, kind: string, signal?: AbortSignal): Promise<CacheEntry>;
  abort(): void;
}
/** Files fetched for previews, least recently used out first. */
export const FILE_CACHE_LIMIT = 500 * 1024 * 1024;
// LocalData refuses values over 1,000,000 characters; long keys (run paths) shrink the index.
const INDEX_CHARS = 900_000;

/**
 * Preview cache of one phone, per paired computer: blobs keyed by source + revision, an LRU
 * index in the local database, and nothing beyond what the computer returned (text arrives
 * already redacted). Unpairing removes the computer's folder and index.
 */
export class FileCache {
  private tail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  constructor(
    private readonly data: LocalData,
    private readonly blobs: BlobFiles,
    private readonly limit = FILE_CACHE_LIMIT,
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined); // The caller owns the error; later writes still run.
    return next;
  }
  /** Thread thumbnails re-check the cache when a blob lands or the cache is cleared. */
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    for (const listener of this.listeners) listener();
  }
  private async index(computerId: string) {
    const parsed = IndexSchema.safeParse(await this.data.get(`files:${computerId}`));
    // A corrupt index only loses the cache; blobs it no longer names are cleared with the folder.
    return parsed.success ? parsed.data : [];
  }
  private async save(computerId: string, rows: CacheEntry[]) {
    const kept = [...rows].sort((a, b) => b.usedAt - a.usedAt);
    while (kept.length && JSON.stringify(kept).length > INDEX_CHARS)
      this.blobs.remove((kept.pop() as CacheEntry).blob);
    await this.data.put(`files:${computerId}`, kept);
  }
  get(computerId: string, key: string): Promise<CacheEntry | undefined> {
    return this.serial(async () => {
      const rows = await this.index(computerId);
      const entry = rows.find((row) => row.key === key);
      if (!entry) return undefined;
      if (this.blobs.size(entry.blob) === null) {
        await this.save(
          computerId,
          rows.filter((row) => row !== entry),
        );
        return undefined;
      }
      entry.usedAt = Date.now();
      await this.save(computerId, rows);
      return entry;
    });
  }
  uri(entry: CacheEntry) {
    return this.blobs.uri(entry.blob);
  }
  readText(entry: CacheEntry) {
    return this.blobs.readText(entry.blob);
  }
  /** Looks up without touching the LRU order or the index (thumbnails, prefetch checks). */
  async peek(computerId: string, key: string) {
    const entry = (await this.index(computerId)).find((row) => row.key === key);
    return entry && this.blobs.size(entry.blob) !== null ? entry : undefined;
  }
  /** A new blob for `key`; it replaces the cached one only on commit. */
  begin(computerId: string, key: string, extension: string): CacheWriter {
    const blob = `${computerId}/${crypto.randomUUID()}.${extension.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin"}`;
    let written = false;
    return {
      append: async (chunk, encoding) => {
        written = true;
        await this.blobs.append(blob, chunk, encoding);
      },
      commit: (revision, kind, signal) =>
        this.serial(async () => {
          signal?.throwIfAborted();
          if (!written) await this.blobs.append(blob, "", "utf8");
          const entry: CacheEntry = {
            key,
            revision,
            kind,
            blob,
            bytes: this.blobs.size(blob) ?? 0,
            usedAt: Date.now(),
          };
          const rows = await this.index(computerId);
          // A retired page must not recreate an index after unpair clears it.
          signal?.throwIfAborted();
          for (const row of rows) if (row.key === key) this.blobs.remove(row.blob);
          const kept = [entry, ...rows.filter((row) => row.key !== key)];
          kept.sort((a, b) => b.usedAt - a.usedAt);
          let total = kept.reduce((sum, row) => sum + row.bytes, 0);
          while (total > this.limit && kept.length > 1) {
            const old = kept.pop() as CacheEntry;
            total -= old.bytes;
            this.blobs.remove(old.blob);
          }
          await this.save(computerId, kept);
          this.changed();
          return entry;
        }),
      abort: () => this.blobs.remove(blob),
    };
  }
  async putText(
    computerId: string,
    key: string,
    revision: string,
    kind: string,
    text: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const writer = this.begin(computerId, key, "json");
    try {
      await writer.append(text, "utf8");
      return await writer.commit(revision, kind, signal);
    } catch (error) {
      writer.abort();
      throw error;
    }
  }
  clear(computerId: string) {
    return this.serial(async () => {
      this.blobs.removeFolder(computerId);
      await this.data.removePrefix(`files:${computerId}`);
      this.changed();
    });
  }
  async settled() {
    await this.tail;
  }
}
/** In-memory blobs for the dev probes and Node scenarios. */
export function memoryBlobFiles(): BlobFiles & { stored(): number } {
  const blobs = new Map<string, string[]>();
  return {
    async append(name, chunk, encoding) {
      const parts = blobs.get(name) ?? [];
      parts.push(encoding === "base64" ? atob(chunk) : chunk);
      blobs.set(name, parts);
    },
    async readText(name) {
      const parts = blobs.get(name);
      if (!parts) throw new Error("blob_missing");
      return parts.join("");
    },
    uri: (name) => `memory://${name}`,
    size: (name) => {
      const parts = blobs.get(name);
      return parts ? parts.reduce((sum, part) => sum + part.length, 0) : null;
    },
    remove: (name) => void blobs.delete(name),
    removeFolder(folder) {
      for (const name of blobs.keys()) if (name.startsWith(`${folder}/`)) blobs.delete(name);
    },
    stored: () => blobs.size,
  };
}
