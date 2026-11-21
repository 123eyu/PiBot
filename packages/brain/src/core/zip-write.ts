import { crc32, deflateRawSync } from "node:zlib";

/**
 * Minimal zip writer for `.pibot` version 3, the counterpart of `skill-zip.ts readZip`:
 * deflate entries, UTF-8 names, no ZIP64 (callers cap the archive far below 4 GB and 65 535
 * entries), a fixed timestamp so the same group exports to the same bytes. No new dependency.
 */
export function writeZip(entries: readonly { path: string; data: Buffer }[]): Buffer {
  if (entries.length > 0xffff) throw new RangeError("Too many zip entries");
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00 in MS-DOS date/time.
  const time = 0;
  const date = 0x21;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const compressed = deflateRawSync(entry.data);
    const stored = compressed.length >= entry.data.length;
    const body = stored ? entry.data : compressed;
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(header, name);
    offset += local.length + name.length + body.length;
    if (offset > 0xfffffffe) throw new RangeError("Zip too large");
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
