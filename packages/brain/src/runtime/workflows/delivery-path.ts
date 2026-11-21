import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { sameFile } from "@pibot/execution";

import type { WorkspaceFileAccess } from "../../resources/workplaces/workspace-files.ts";

/** Check every ancestor before opening: a linked parent must not turn checks into arbitrary reads. */
export async function deliveryFile(
  root: string,
  path: string,
  signal: AbortSignal,
  maxBytes?: number,
  files?: WorkspaceFileAccess,
) {
  if (files?.remote) return files.read(root, path, signal, maxBytes);
  signal.throwIfAborted();
  const base = await realpath(root);
  if (base !== resolve(root)) return undefined;
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  // Exact (bigint) identities: number stats round NTFS file IDs and can alias two files.
  const before = await lstat(target, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) return undefined;
  let parent = target;
  while (parent !== base) {
    const info = await lstat(parent);
    if (info.isSymbolicLink()) return undefined;
    parent = dirname(parent);
  }
  // A regular file can be replaced by a FIFO after lstat; never wait for its writer.
  signal.throwIfAborted();
  const file = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    signal.throwIfAborted();
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || !sameFile(info, before)) return undefined;
    const current = await lstat(target, { bigint: true });
    if ((await realpath(target)) !== target || !sameFile(current, info)) return undefined;
    const fileSize = Number(info.size);
    if (maxBytes === undefined) return { size: fileSize };
    if (fileSize > maxBytes) return { size: fileSize };
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    signal.throwIfAborted();
    if (size > maxBytes) return { size };
    return { size, data: Buffer.concat(chunks, size) };
  } finally {
    await file.close();
  }
}
