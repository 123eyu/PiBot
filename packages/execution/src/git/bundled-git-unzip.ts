import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

const inflate = promisify(inflateRaw);
// MinGit has under 600 entries; the bound only stops a malformed directory from looping long.
const MAX_ENTRIES = 5_000;
const MAX_ENTRY = 256 * 1024 * 1024;
// Windows Defender scans every new executable as it is written; a few writes in flight overlap
// those scans without flooding the disk.
const PARALLEL_WRITES = 8;
// Windows-invalid name characters (and stream names via ':'); control characters are refused
// separately because a regex range over them is easy to misread.
const UNSAFE_NAME = /[<>:"|?*\\]/;
const control = (part: string) => [...part].some((char) => char.charCodeAt(0) < 0x20);

interface Entry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  local: number;
}

/**
 * Unpacks the bundled MinGit zip into an empty folder. The caller has already matched the
 * archive's SHA-256, so this is the published release; the checks below still refuse anything a
 * damaged reader could turn into a write outside `target` (absolute, `..`, drive or stream names).
 * Only stored and deflate entries without ZIP64 or encryption, which is what MinGit uses.
 */
export async function unzipInto(archive: Buffer, target: string, signal: AbortSignal) {
  const entries = centralDirectory(archive);
  const folders = new Set<string>();
  const files: Entry[] = [];
  for (const entry of entries) {
    const parts = entry.name.split("/");
    if (entry.name.endsWith("/")) parts.pop();
    if (
      !parts.length ||
      parts.some(
        (part) => !part || part === "." || part === ".." || UNSAFE_NAME.test(part) || control(part),
      )
    )
      throw new Error("bundled_git_archive_unsafe");
    if (entry.name.endsWith("/")) folders.add(join(target, ...parts));
    else {
      if (parts.length > 1) folders.add(join(target, ...parts.slice(0, -1)));
      files.push(entry);
    }
  }
  for (const folder of [...folders].sort((a, b) => a.length - b.length)) {
    signal.throwIfAborted();
    await mkdir(folder, { recursive: true });
  }
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      signal.throwIfAborted();
      const entry = files[next++] as Entry;
      const data = await contents(archive, entry);
      // `wx`: the folder is new and private to this extraction; an existing name means a duplicate.
      await writeFile(join(target, ...entry.name.split("/")), data, { flag: "wx", signal });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_WRITES, files.length) }, worker));
}

function centralDirectory(archive: Buffer): Entry[] {
  const end = endOfCentralDirectory(archive);
  const count = archive.readUInt16LE(end + 10);
  const size = archive.readUInt32LE(end + 12);
  let offset = archive.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES || offset + size > end) throw new Error("bundled_git_archive_invalid");
  const entries: Entry[] = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("bundled_git_archive_invalid");
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressed = archive.readUInt32LE(offset + 20);
    const uncompressed = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1 || (method !== 0 && method !== 8) || uncompressed > MAX_ENTRY)
      throw new Error("bundled_git_archive_unsupported");
    entries.push({ name, method, compressed, size: uncompressed, local });
  }
  return entries;
}

async function contents(archive: Buffer, entry: Entry): Promise<Buffer> {
  if (entry.local + 30 > archive.length || archive.readUInt32LE(entry.local) !== 0x04034b50)
    throw new Error("bundled_git_archive_invalid");
  const start =
    entry.local +
    30 +
    archive.readUInt16LE(entry.local + 26) +
    archive.readUInt16LE(entry.local + 28);
  const raw = archive.subarray(start, start + entry.compressed);
  if (raw.length !== entry.compressed) throw new Error("bundled_git_archive_invalid");
  // Inflating off the main thread keeps a ~100 MB unpack from stalling the brain's event loop.
  const data =
    entry.method === 0
      ? raw
      : await inflate(raw, { maxOutputLength: Math.max(1, entry.size) }).catch(() => {
          throw new Error("bundled_git_archive_invalid");
        });
  if (data.length !== entry.size) throw new Error("bundled_git_archive_invalid");
  return data;
}

function endOfCentralDirectory(archive: Buffer) {
  if (archive.length < 22) throw new Error("bundled_git_archive_invalid");
  const floor = Math.max(0, archive.length - 22 - 0xffff);
  for (let index = archive.length - 22; index >= floor; index--)
    if (archive.readUInt32LE(index) === 0x06054b50) return index;
  throw new Error("bundled_git_archive_invalid");
}
