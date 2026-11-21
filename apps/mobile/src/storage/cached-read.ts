import type { z } from "zod";
import type { FileCache } from "./file-cache.ts";

/**
 * A read-only computer answer kept in the file cache (diffs, a run's changes, task details):
 * online it is read and stored, offline the stored copy is returned (validated again, like any
 * input). Shares the 500 MB LRU, so it is bounded and cleared on unpair with the files.
 */
export async function cachedRead<T extends z.ZodType>(
  cache: FileCache,
  input: { computerId: string; online: boolean; key: string; schema: T; signal?: AbortSignal },
  read: () => Promise<z.infer<T>>,
): Promise<{ value: z.infer<T>; stale: boolean }> {
  if (!input.online) {
    const entry = await cache.get(input.computerId, input.key);
    if (!entry) throw new Error("offline");
    return { value: input.schema.parse(JSON.parse(await cache.readText(entry))), stale: true };
  }
  const value = await read();
  const json = JSON.stringify(value);
  // Revision is informative here; these answers are replaced wholesale on every online read.
  await cache.putText(input.computerId, input.key, `${json.length}`, "json", json, input.signal);
  return { value, stale: false };
}
