import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const checkpointSchema = z.object({
  id: z.string().min(1).max(128),
  timestamp: z.iso.datetime(),
  tokensBefore: z.number().finite().nonnegative(),
});
const entrySchema = z.object({
  type: z.string(),
  id: z.string().min(1).max(128),
  parentId: z.string().max(128).nullable(),
});
type Node = {
  parent: string | null;
  checkpoint?: z.infer<typeof checkpointSchema>;
};

/** Read-only v3 inspection: SessionManager.open may migrate/write and is unsuitable for status UI. */
export async function readSessionRecovery(input: {
  sessionDir: string;
  sessionFile: string;
  signal: AbortSignal;
  /** Optional event-stream waterline; checked only against the active JSONL branch. */
  expectedEntryId?: string;
}) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
  const root = resolve(input.sessionDir),
    file = resolve(input.sessionFile);
  signal.throwIfAborted();
  // Identity checks read bigint stats: number inodes lose precision on NTFS (see
  // execution core/file-identity.ts), letting a neighbouring entry pass as the same one.
  const directory = await lstat(root, { bigint: true });
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    dirname(file) !== root ||
    (await realpath(root)) !== root ||
    (await realpath(file)) !== file
  )
    throw new Error("Unmanaged session");
  const pathBefore = await lstat(file, { bigint: true });
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    const same = (value: typeof before) =>
      value.isFile() &&
      value.nlink === 1n &&
      value.size <= 50_000_000n &&
      value.dev === before.dev &&
      value.ino === before.ino &&
      value.size === before.size &&
      value.mtimeMs === before.mtimeMs &&
      value.ctimeMs === before.ctimeMs;
    if (!same(pathBefore) || !same(before)) throw new Error("Session changed or exceeds budget");
    const nodes = new Map<string, Node>();
    let header = false,
      leaf: string | null = null,
      pending = "",
      bytes = 0;
    const consume = (line: string) => {
      signal.throwIfAborted();
      if (!line.trim()) return;
      const raw = JSON.parse(line);
      if (!header) {
        z.object({
          type: z.literal("session"),
          version: z.literal(3),
          id: z.string(),
          cwd: z.string(),
        }).parse(raw);
        header = true;
        return;
      }
      const entry = entrySchema.parse(raw);
      if (
        nodes.size >= 100_000 ||
        nodes.has(entry.id) ||
        (entry.parentId && !nodes.has(entry.parentId))
      )
        throw new Error("Invalid session branch");
      nodes.set(entry.id, {
        parent: entry.parentId,
        checkpoint: entry.type === "compaction" ? checkpointSchema.parse(raw) : undefined,
      });
      leaf = entry.id;
    };
    const decoder = new TextDecoder("utf-8", { fatal: true }),
      buffer = Buffer.alloc(32768);
    for (;;) {
      signal.throwIfAborted();
      const read = await handle.read(buffer);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > 50_000_000) throw new Error("Session exceeds budget");
      pending += decoder.decode(buffer.subarray(0, read.bytesRead), { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        if (newline > 2_000_000) throw new Error("Session line exceeds budget");
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > 2_000_000) throw new Error("Session line exceeds budget");
    }
    pending += decoder.decode();
    if (pending.trim() || !header) throw new Error("Incomplete session");
    const current = await lstat(file, { bigint: true }),
      parent = await lstat(root, { bigint: true });
    signal.throwIfAborted();
    if (
      !same(await handle.stat({ bigint: true })) ||
      !same(current) ||
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.dev !== directory.dev ||
      parent.ino !== directory.ino ||
      (await realpath(root)) !== root ||
      (await realpath(file)) !== file
    )
      throw new Error("Session changed");
    const tailEntryId = leaf;
    let checkpoint: z.infer<typeof checkpointSchema> | undefined,
      entryCount = 0,
      expectedEntryOnBranch = input.expectedEntryId === undefined ? undefined : false;
    while (leaf !== null) {
      signal.throwIfAborted();
      const node = nodes.get(leaf);
      if (!node) throw new Error("Invalid session branch");
      entryCount++;
      if (leaf === input.expectedEntryId) expectedEntryOnBranch = true;
      checkpoint ??= node.checkpoint;
      leaf = node.parent;
    }
    return {
      entryCount,
      tailEntryId,
      expectedEntryOnBranch,
      checkpoint: checkpoint
        ? {
            id: checkpoint.id,
            createdAt: checkpoint.timestamp,
            tokensBefore: checkpoint.tokensBefore,
          }
        : null,
    };
  } finally {
    await handle.close();
  }
}
