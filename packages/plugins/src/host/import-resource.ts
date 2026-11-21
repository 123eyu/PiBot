import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { looksLikeCredentialValue } from "@pibot/plugins-contract";
import { envExampleFilter, SKILL_IMPORT_FILE_MAX_BYTES } from "@pibot/plugins-contract/full";

export interface ImportResource {
  byteLength: number;
  chunks(signal: AbortSignal): AsyncGenerator<Buffer>;
}
export type ImportParentCache = Map<string, { path: string; stat: BigIntStats }>;
export type ImportContent = Uint8Array | ImportResource;
export async function* importChunks(
  content: ImportContent,
  signal: AbortSignal,
  activity?: () => void,
): AsyncGenerator<Buffer> {
  signal.throwIfAborted();
  if (content instanceof Uint8Array) {
    activity?.();
    yield Buffer.from(content);
  } else
    for await (const chunk of content.chunks(signal)) {
      activity?.();
      yield chunk;
    }
}
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;
const invalid = () => new Error("connector_import_invalid_source");

/** Host cannot import brain/execution; keep this identity-bound disk adapter local to the host. */
export async function importResource(
  root: string,
  path: string,
  max: number,
  cache: ImportParentCache = new Map(),
): Promise<ImportResource> {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw invalid();
  const absolute = resolve(path);
  const parents: { path: string; stat: BigIntStats }[] = [];
  for (let parent = dirname(absolute); ; ) {
    let cached = cache.get(parent);
    if (!cached) {
      const stat = await lstat(parent, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
      cached = { path: parent, stat };
      cache.set(parent, cached);
    }
    parents.push(cached);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const stat = await lstat(absolute, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > BigInt(Math.min(max, SKILL_IMPORT_FILE_MAX_BYTES))
  )
    throw invalid();
  const canonical = await realpath(absolute);
  return {
    byteLength: Number(stat.size),
    async *chunks(signal) {
      signal.throwIfAborted();
      for (const parent of parents) {
        const current = await lstat(parent.path, { bigint: true });
        if (
          current.isSymbolicLink() ||
          !current.isDirectory() ||
          current.dev !== parent.stat.dev ||
          current.ino !== parent.stat.ino
        )
          throw invalid();
      }
      if (
        (await realpath(absolute)) !== canonical ||
        !same(stat, await lstat(absolute, { bigint: true }))
      )
        throw invalid();
      const file = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const sanitize =
        basename(path).toLowerCase() === ".env.example" ? envExampleFilter() : undefined;
      try {
        if (!same(stat, await file.stat({ bigint: true }))) throw invalid();
        let offset = 0,
          carry = "";
        while (offset < Number(stat.size)) {
          signal.throwIfAborted();
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Number(stat.size) - offset));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) throw invalid();
          offset += bytesRead;
          const raw = buffer.subarray(0, bytesRead);
          const chunk = sanitize ? Buffer.from(sanitize(raw)) : raw;
          const text = carry + chunk.toString("utf8");
          if (looksLikeCredentialValue(text)) throw invalid();
          // Credential detection's longest prefix + minimum suffix is under 64 ASCII chars.
          carry = text.slice(-64);
          yield chunk;
        }
        if (
          !same(stat, await file.stat({ bigint: true })) ||
          !same(stat, await lstat(absolute, { bigint: true })) ||
          (await realpath(absolute)) !== canonical
        )
          throw invalid();
      } finally {
        await file.close();
      }
    },
  };
}
