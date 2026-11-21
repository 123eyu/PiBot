import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { sameFile } from "../core/file-identity.ts";
import { ExecError } from "../core/types.ts";
import type { CheckpointBytes } from "./file-checkpoint.ts";

async function readCheckpoint(
  path: string,
  signal: AbortSignal,
  maxBytes = 5 * 1024 * 1024,
  hashOnly = false,
): Promise<{ image: CheckpointBytes; bytes: Buffer }> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024)
    throw new ExecError("invalid_input");
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(maxBytes) ||
    (await realpath(path)) !== path
  )
    throw new ExecError("file_conflict");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const first = await handle.stat({ bigint: true });
    if (!sameFile(first, before) || first.nlink !== 1n || first.size > BigInt(maxBytes))
      throw new ExecError("file_conflict");
    const buffer = Buffer.alloc(hashOnly ? 1024 * 1024 : Number(first.size) + 1);
    const digest = createHash("sha256");
    let used = 0;
    while (hashOnly || used < buffer.length) {
      signal.throwIfAborted();
      const read = await handle.read(
        buffer,
        hashOnly ? 0 : used,
        hashOnly ? buffer.length : buffer.length - used,
        used,
      );
      if (!read.bytesRead) break;
      digest.update(buffer.subarray(hashOnly ? 0 : used, (hashOnly ? 0 : used) + read.bytesRead));
      used += read.bytesRead;
      if (used > maxBytes) throw new ExecError("file_conflict");
    }
    const bytes = hashOnly ? Buffer.alloc(0) : buffer.subarray(0, used);
    const [last, named] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      used > maxBytes ||
      !sameFile(first, last) ||
      first.mtimeNs !== last.mtimeNs ||
      first.ctimeNs !== last.ctimeNs ||
      last.size !== BigInt(used) ||
      !sameFile(named, last) ||
      named.nlink !== 1n
    )
      throw new ExecError("file_conflict");
    return {
      image: { hash: digest.digest("hex"), bytes: used, mode: Number(last.mode & 0o777n) },
      bytes,
    };
  } finally {
    await handle.close();
  }
}
export function readCheckpointFile(path: string, signal: AbortSignal, maxBytes?: number) {
  return readCheckpoint(path, signal, maxBytes);
}
/** Same identity/version checks, but a bounded buffer for verification-only reads. */
export async function hashCheckpointFile(path: string, signal: AbortSignal, maxBytes?: number) {
  return (await readCheckpoint(path, signal, maxBytes, true)).image;
}
