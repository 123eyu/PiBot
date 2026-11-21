import type { CacheEntry, FileCache } from "../../storage/file-cache.ts";
import type { Caller } from "../chat/controls/scope.ts";
import { extensionOf, type FileSource, sourceKey } from "./source.ts";

export interface FetchedFile {
  entry: CacheEntry;
  /** The cached copy was shown without asking the computer (offline). */
  stale: boolean;
}
/**
 * Reads one preview file through remote.preview.read slice by slice into the phone cache.
 * Online, a cached revision is revalidated (an unchanged file costs one tiny reply); offline,
 * the cached copy is returned as is. Slices go straight to disk, never held as one string.
 */
export async function fetchPreviewFile(
  c: Caller,
  cache: FileCache,
  input: {
    computerId: string;
    online: boolean;
    source: FileSource;
    name: string;
    onProgress?: (done: number, total: number) => void;
  },
  signal?: AbortSignal,
): Promise<FetchedFile> {
  const key = sourceKey(input.source);
  const cached = await cache.get(input.computerId, key);
  if (!input.online) {
    if (cached) return { entry: cached, stale: true };
    throw new Error("offline");
  }
  const first = await c.call(
    "remote.preview.read",
    { ...input.source, offset: 0, ...(cached ? { cached: cached.revision } : {}) },
    signal,
    40_000,
  );
  if (first.unchanged && cached) return { entry: cached, stale: false };
  const writer = cache.begin(input.computerId, key, extensionOf(input.name));
  try {
    let chunk = first;
    let offset = 0;
    for (;;) {
      await writer.append(chunk.chunk, chunk.encoding);
      offset += chunk.chunk.length;
      input.onProgress?.(offset, chunk.total);
      if (offset >= chunk.total) break;
      if (!chunk.chunk.length) throw new Error("preview_incomplete");
      signal?.throwIfAborted();
      chunk = await c.call(
        "remote.preview.read",
        { ...input.source, offset, revision: first.revision },
        signal,
        40_000,
      );
      if (chunk.revision !== first.revision || chunk.offset !== offset)
        throw new Error("preview_incomplete");
    }
    return { entry: await writer.commit(first.revision, first.kind), stale: false };
  } catch (error) {
    writer.abort();
    throw error;
  }
}
