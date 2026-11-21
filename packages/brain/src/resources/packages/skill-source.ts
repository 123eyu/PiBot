import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";
import {
  SKILL_IMPORT_FILE_MAX_BYTES,
  SKILL_IMPORT_MAX_BYTES,
  SKILL_IMPORT_MAX_FILES,
} from "@pibot/protocol-base";
import { junkPath, PackageError, packagePath } from "./skill-package.ts";
import { ZipError } from "./skill-zip.ts";

export interface SkillSourceFile {
  path: string;
  bytes: number;
  /** Private brain-only capability, never serialized into a preview. */
  chunks(
    signal: AbortSignal,
    start?: number,
    length?: number,
    activity?: () => void,
  ): AsyncGenerator<Buffer>;
}
export interface SkillSourceEntries {
  files: SkillSourceFile[];
  skipped: number;
  archiveComment?: string;
}
const unsafe = () => new PackageError("unsafe");
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;

/** Bind every ancestor as well as the leaf so a replaced directory cannot redirect the read. */
type SourceParent = { path: string; stat: BigIntStats };
export async function sourceFile(
  path: string,
  name: string,
  parentCache?: Map<string, SourceParent>,
): Promise<SkillSourceFile & { identity: BigIntStats }> {
  const absolute = parentCache
    ? resolve(path)
    : join(await realpath(dirname(resolve(path))), basename(path));
  const cache = parentCache ?? new Map<string, SourceParent>();
  const ancestors: { path: string; stat: BigIntStats }[] = [];
  for (let parent = dirname(absolute); ; ) {
    let cached = cache.get(parent);
    if (!cached) {
      const stat = await lstat(parent, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
      cached = { path: parent, stat };
      cache.set(parent, cached);
    }
    ancestors.push(cached);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const stat = await lstat(absolute, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw unsafe();
  const canonical = await realpath(absolute);
  const verify = async () => {
    for (const parent of ancestors) {
      const current = await lstat(parent.path, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== parent.stat.dev ||
        current.ino !== parent.stat.ino
      )
        throw unsafe();
    }
    if ((await realpath(absolute)) !== canonical) throw unsafe();
    if (!same(stat, await lstat(absolute, { bigint: true }))) throw unsafe();
  };
  return {
    path: name,
    identity: stat,
    bytes: Number(stat.size),
    async *chunks(signal, start = 0, length = Number(stat.size), activity) {
      signal.throwIfAborted();
      await verify();
      const file = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!same(stat, await file.stat({ bigint: true }))) throw unsafe();
        let offset = start;
        const end = Math.min(Number(stat.size), start + length);
        while (offset < end) {
          signal.throwIfAborted();
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - offset));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) throw unsafe();
          offset += bytesRead;
          activity?.();
          yield buffer.subarray(0, bytesRead);
        }
        if (!same(stat, await file.stat({ bigint: true }))) throw unsafe();
      } finally {
        await file.close();
        await verify();
      }
    },
  };
}

export async function folderEntries(
  root: string,
  signal: AbortSignal,
  activity?: () => void,
): Promise<SkillSourceEntries> {
  const files: SkillSourceFile[] = [];
  const names = new Set<string>();
  const parents = new Map<string, SourceParent>();
  let total = 0;
  let skipped = 0;
  const walk = async (folder: string, prefix: string) => {
    signal.throwIfAborted();
    const stat = await lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
    for await (const entry of await opendir(folder)) {
      signal.throwIfAborted();
      const child = join(folder, entry.name);
      const current = await lstat(child);
      activity?.();
      // Skipped folders are never entered, so their contents (a venv's interpreter symlinks, odd
      // file names) can't fail the import; a symlinked junk folder is skipped the same way.
      const raw = prefix + entry.name;
      if (junkPath(current.isDirectory() || current.isSymbolicLink() ? `${raw}/_` : raw)) {
        skipped++;
        continue;
      }
      const name = packagePath(raw);
      if (current.isSymbolicLink() || (!current.isDirectory() && !current.isFile())) throw unsafe();
      const key = name.toLowerCase();
      if (names.has(key)) throw unsafe();
      names.add(key);
      // Bound empty-directory trees too; retained file limit remains independent.
      if (names.size > 100_000) throw new PackageError("too_many_files");
      if (current.isDirectory()) await walk(child, `${name}/`);
      else {
        const file = await sourceFile(child, name, parents);
        total += file.bytes;
        // One oversized file and an oversized package mean different things to the person.
        if (file.bytes > SKILL_IMPORT_FILE_MAX_BYTES) throw new PackageError("file_too_large");
        if (total > SKILL_IMPORT_MAX_BYTES) throw new PackageError("too_large");
        if (files.length >= SKILL_IMPORT_MAX_FILES) throw new PackageError("too_many_files");
        files.push(file);
      }
    }
  };
  const selected = await lstat(root, { bigint: true });
  if (!selected.isDirectory() || selected.isSymbolicLink()) throw unsafe();
  const canonical = await realpath(root);
  const actual = await lstat(canonical, { bigint: true });
  if (actual.dev !== selected.dev || actual.ino !== selected.ino) throw unsafe();
  await walk(canonical, "");
  return { files, skipped };
}

/** Bounded random reads for ZIP metadata; no archive or decompressed package buffer. */
export async function zipEntries(
  path: string,
  signal: AbortSignal,
  activity?: () => void,
  limits?: { maxCompressionRatio: number },
): Promise<SkillSourceEntries> {
  const archive = await sourceFile(path, "archive.zip");
  if (archive.bytes > SKILL_IMPORT_MAX_BYTES) throw new PackageError("too_large");
  const file = await open(
    join(await realpath(dirname(resolve(path))), basename(path)),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const read = async (start: number, length: number) => {
    signal.throwIfAborted();
    if (start < 0 || length < 0 || start + length > archive.bytes) throw unsafe();
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const result = await file.read(buffer, offset, length - offset, start + offset);
      if (!result.bytesRead) throw unsafe();
      offset += result.bytesRead;
      activity?.();
    }
    return buffer;
  };
  try {
    const initial = await file.stat({ bigint: true });
    if (!same(archive.identity, initial)) throw unsafe();
    const ranges: { start: number; end: number }[] = [];
    const tail = await read(Math.max(0, archive.bytes - 65_557), Math.min(archive.bytes, 65_557));
    let end = tail.length - 22;
    for (; end >= 0; end--)
      if (
        tail.readUInt32LE(end) === 0x06054b50 &&
        end + 22 + tail.readUInt16LE(end + 20) === tail.length
      )
        break;
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw unsafe();
    const count = tail.readUInt16LE(end + 10);
    if (count === 0xffff || count !== tail.readUInt16LE(end + 8)) throw unsafe();
    let offset = tail.readUInt32LE(end + 16);
    const centralEnd = offset + tail.readUInt32LE(end + 12);
    if (centralEnd > archive.bytes - tail.length + end) throw unsafe();
    const names = new Map<string, string>();
    const files: SkillSourceFile[] = [];
    const kept = new Set<string>();
    const directories = new Set<string>();
    let total = 0;
    let skipped = 0;
    let rawBytes = 0,
      rawFiles = 0;
    for (let n = 0; n < count; n++) {
      const header = await read(offset, 46);
      if (header.readUInt32LE(0) !== 0x02014b50) throw unsafe();
      const flags = header.readUInt16LE(8),
        method = header.readUInt16LE(10);
      const compressed = header.readUInt32LE(20),
        bytes = header.readUInt32LE(24);
      const nameBytes = header.readUInt16LE(28);
      const raw = (await read(offset + 46, nameBytes)).toString("utf8").replaceAll("\\", "/");
      offset += 46 + nameBytes + header.readUInt16LE(30) + header.readUInt16LE(32);
      if (
        offset > centralEnd ||
        flags & 1 ||
        compressed === 0xffffffff ||
        bytes === 0xffffffff ||
        (method !== 0 && method !== 8)
      )
        throw unsafe();
      const directory = raw.endsWith("/");
      const name = packagePath(directory ? raw.slice(0, -1) : raw);
      const mode = header[5] === 3 ? (header.readUInt32LE(38) >>> 16) & 0o170000 : 0;
      if (mode && mode !== (directory ? 0o040000 : 0o100000)) throw unsafe();
      const parts = name.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const part = parts.slice(0, i).join("/");
        const key = part.toLowerCase(),
          previous = names.get(key);
        if (previous && previous !== part) throw unsafe();
        if (i < parts.length || directory) {
          if (kept.has(key)) throw unsafe();
          directories.add(key);
        }
        names.set(key, part);
      }
      const local = header.readUInt32LE(42);
      const localHeader = await read(local, 30);
      if (
        localHeader.readUInt32LE(0) !== 0x04034b50 ||
        localHeader.readUInt16LE(8) !== method ||
        localHeader.readUInt16LE(6) !== flags ||
        (!(flags & 8) &&
          (localHeader.readUInt32LE(14) !== header.readUInt32LE(16) ||
            localHeader.readUInt32LE(18) !== compressed ||
            localHeader.readUInt32LE(22) !== bytes))
      )
        throw unsafe();
      const localName = (await read(local + 30, localHeader.readUInt16LE(26)))
        .toString("utf8")
        .replaceAll("\\", "/")
        .normalize("NFC");
      if (localName !== (directory ? `${name}/` : name)) throw unsafe();
      const start = local + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28);
      if (start + compressed > tail.readUInt32LE(end + 16)) throw unsafe();
      ranges.push({ start: local, end: start + compressed });
      if (limits && !directory) {
        rawBytes += bytes;
        rawFiles++;
        if (bytes > SKILL_IMPORT_FILE_MAX_BYTES) throw new PackageError("file_too_large");
        if (rawBytes > SKILL_IMPORT_MAX_BYTES) throw new PackageError("too_large");
        if (rawFiles > SKILL_IMPORT_MAX_FILES) throw new PackageError("too_many_files");
        if (bytes > Math.max(1024 * 1024, compressed * limits.maxCompressionRatio))
          throw new PackageError("too_large");
      }
      if (directory) continue;
      if (junkPath(name)) {
        skipped++;
        continue;
      }
      if (kept.has(name.toLowerCase()) || directories.has(name.toLowerCase())) throw unsafe();
      kept.add(name.toLowerCase());
      total += bytes;
      if (bytes > SKILL_IMPORT_FILE_MAX_BYTES) throw new PackageError("file_too_large");
      if (total > SKILL_IMPORT_MAX_BYTES) throw new PackageError("too_large");
      if (files.length >= SKILL_IMPORT_MAX_FILES) throw new PackageError("too_many_files");
      const expectedCrc = header.readUInt32LE(16);
      files.push({
        path: name,
        bytes,
        async *chunks(abort, offset = 0, length = bytes, activity) {
          if (offset !== 0) throw unsafe();
          // Open the archive through the identity-bound source, then select this compressed range.
          const input = archive.chunks(abort, start, compressed, activity);
          const { Readable } = await import("node:stream");
          const rawStream = Readable.from(input, { objectMode: false, signal: abort });
          const output =
            method === 8 ? rawStream.compose(createInflateRaw(), { signal: abort }) : rawStream;
          const stop = () => output.destroy(new PackageError("cancelled"));
          abort.addEventListener("abort", stop, { once: true });
          let size = 0,
            checksum = 0;
          try {
            for await (const chunk of output) {
              abort.throwIfAborted();
              checksum = crc32(chunk, checksum);
              size += chunk.length;
              if (size > bytes) throw unsafe();
              const buffer = chunk as Buffer;
              const from = Math.max(0, size - buffer.length);
              yield buffer.subarray(0, Math.max(0, Math.min(buffer.length, length - from)));
              if (length < bytes && size >= length) return;
            }
            if (size !== bytes || checksum !== expectedCrc) throw new ZipError("damaged");
          } catch (error) {
            abort.throwIfAborted();
            if (error instanceof PackageError || error instanceof ZipError) throw error;
            throw new ZipError("damaged");
          } finally {
            abort.removeEventListener("abort", stop);
            output.destroy();
            rawStream.destroy();
            // The consumer owns the stream error; draining here only closes its bound file handle.
            await finished(rawStream, { cleanup: true }).catch(() => undefined);
          }
        },
      });
    }
    ranges.sort((a, b) => a.start - b.start);
    let previousEnd = 0;
    for (const range of ranges) {
      if (range.start < previousEnd) throw unsafe();
      previousEnd = range.end;
    }
    if (offset !== centralEnd || !same(initial, await file.stat({ bigint: true }))) throw unsafe();
    // Collision of a file and an implicit folder must fail before staging is created.
    const fileNames = new Set(files.map((entry) => entry.path.toLowerCase()));
    for (const entry of files) {
      const parts = entry.path.toLowerCase().split("/");
      for (let i = 1; i < parts.length; i++)
        if (fileNames.has(parts.slice(0, i).join("/"))) throw unsafe();
    }
    await archive.chunks(signal, 0, 0).next();
    return { files, skipped, archiveComment: tail.subarray(end + 22).toString("utf8") };
  } finally {
    await file.close();
  }
}

export function contained(root: string, name: string) {
  const target = join(root, ...packagePath(name).split("/"));
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw unsafe();
  return target;
}
