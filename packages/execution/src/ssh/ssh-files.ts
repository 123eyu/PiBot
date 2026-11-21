import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { HostSshError, type HostSshFile } from "./ssh-types.ts";

export const sshDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function sshWithin(root: string, path: string) {
  const part = relative(root, path);
  return part === "" || (!part.startsWith("..") && !isAbsolute(part));
}

/** O_NOFOLLOW and canonical parents reject path aliases before any config content is read. */
export async function inspectHostSshFile(
  path: string,
  kind: HostSshFile["kind"],
  signal: AbortSignal,
): Promise<{ file: HostSshFile; text?: string }> {
  signal.throwIfAborted();
  if (!isAbsolute(path) || /[\0\r\n]/.test(path) || (await realpath(path)) !== path)
    throw new HostSshError("unsupported_configuration");
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0)
      throw new HostSshError("unsupported_configuration");
    if (parent === dirname(parent)) break;
  }
  const lexical = await lstat(path);
  if (!lexical.isFile() || lexical.nlink !== 1) throw new HostSshError("unsupported_configuration");
  // Nonblocking prevents a regular-file→FIFO race from holding the preparation/approval open.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    const stamp = (stat: typeof before) =>
      [
        stat.dev,
        stat.ino,
        stat.size,
        stat.mode,
        stat.uid,
        stat.nlink,
        stat.mtimeNs,
        stat.ctimeNs,
      ].map(String);
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > (kind === "program" ? 16_777_216n : 262_144n) ||
      (before.mode & 0o022n) !== 0n ||
      (kind === "identity" && (before.mode & 0o077n) !== 0n) ||
      (kind === "program" && (before.uid !== 0n || (before.mode & 0o111n) === 0n))
    )
      throw new HostSshError("unsupported_configuration");
    signal.throwIfAborted();
    // Private identities are deliberately never read into JS or copied to a temporary file.
    const body = kind === "identity" ? undefined : Buffer.alloc(Number(before.size) + 1);
    let bytes = 0;
    if (body) {
      while (bytes < body.length) {
        signal.throwIfAborted();
        const read = await handle.read(body, bytes, body.length - bytes, bytes);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      if (BigInt(bytes) !== before.size) throw new HostSshError("configuration_changed");
    }
    const after = await handle.stat({ bigint: true });
    if (sshDigest(stamp(before)) !== sshDigest(stamp(after)))
      throw new HostSshError("configuration_changed");
    signal.throwIfAborted();
    return {
      file: {
        path,
        kind,
        version: sshDigest(stamp(after)),
        ...(body
          ? { hash: createHash("sha256").update(body.subarray(0, bytes)).digest("hex") }
          : {}),
      },
      ...(body && kind !== "program" ? { text: body.subarray(0, bytes).toString("utf8") } : {}),
    };
  } finally {
    await handle.close();
  }
}

export async function verifyHostSshFiles(files: readonly HostSshFile[], signal: AbortSignal) {
  for (const previous of files) {
    const { file } = await inspectHostSshFile(previous.path, previous.kind, signal);
    if (file.version !== previous.version || file.hash !== previous.hash)
      throw new HostSshError("configuration_changed");
  }
}
