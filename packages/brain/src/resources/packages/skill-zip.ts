import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  path: string;
  data: Buffer;
}
export class ZipError extends Error {}

export interface ZipLimits {
  /** Sum of uncompressed sizes of the kept entries. */
  maxTotal: number;
  /** Kept file entries (directories and Finder metadata are not counted). */
  maxFiles: number;
  maxFile: number;
  /** Skips an entry before it is inflated (junk such as `.DS_Store`). */
  skip(path: string): boolean;
}

// Unix mode bits in the high half of "external attributes" when the archive was made on Unix.
const UNIX_HOST = 3;
const TYPE_MASK = 0o170000;
const REGULAR = 0o100000;
const DIRECTORY = 0o040000;
// A central directory has 46 bytes per entry; this bounds the work before limits apply.
const MAX_RAW_ENTRIES = 20_000;

/**
 * Reads a skill package archive without a new dependency. Only stored and deflate entries, no
 * encryption, no ZIP64, no absolute or `..` paths, no symlinks or other special files; sizes are
 * checked against the central directory before inflating, and inflating is capped to that size,
 * so a zip bomb fails instead of exhausting memory. Path syntax beyond that is the caller's job.
 */
export function readZip(buffer: Buffer, limits: ZipLimits): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count > MAX_RAW_ENTRIES) throw new ZipError("too_many_files");
  if (offset + size > eocd) throw new ZipError("invalid");
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new ZipError("invalid");
    const host = buffer.readUInt8(offset + 5);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const external = buffer.readUInt32LE(offset + 38);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) throw new ZipError("encrypted");
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new ZipError("invalid");
    const path = name.replaceAll("\\", "/");
    const type = host === UNIX_HOST ? (external >>> 16) & TYPE_MASK : 0;
    if (path.endsWith("/")) {
      if (type && type !== DIRECTORY) throw new ZipError("unsafe");
      continue;
    }
    if (
      !path ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.split("/").some((part) => part === ".." || part === "") ||
      path.includes("\0")
    )
      throw new ZipError("unsafe");
    // A symlink entry would point the saved skill at any file on disk; FIFOs and devices likewise.
    if (type && type !== REGULAR) throw new ZipError("unsafe");
    if (limits.skip(path)) continue;
    if (uncompressed > limits.maxFile) throw new ZipError("too_large");
    total += uncompressed;
    if (total > limits.maxTotal) throw new ZipError("too_large");
    if (entries.length >= limits.maxFiles) throw new ZipError("too_many_files");
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50)
      throw new ZipError("invalid");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressed);
    if (raw.length !== compressed) throw new ZipError("invalid");
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, uncompressed) });
      } catch {
        throw new ZipError("invalid");
      }
    } else throw new ZipError("unsupported_compression");
    if (data.length !== uncompressed) throw new ZipError("invalid");
    entries.push({ path, data });
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < 22) throw new ZipError("invalid");
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= floor; i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  throw new ZipError("invalid");
}
