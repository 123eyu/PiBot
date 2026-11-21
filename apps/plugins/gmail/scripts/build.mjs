import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist/gmail-plugin", { recursive: true, force: true });
await mkdir("dist/gmail-plugin", { recursive: true });
await cp("plugin", "dist/gmail-plugin", { recursive: true });
await build({
  entryPoints: ["server/index.ts"],
  outfile: "dist/gmail-plugin/server.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});

// ZIP store format keeps the import bundle portable without platform zip executables.
const { readdir, readFile, writeFile } = await import("node:fs/promises");
const { join, relative } = await import("node:path");
const local = [],
  central = [];
let offset = 0,
  count = 0;
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
async function add(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await add(path);
      continue;
    }
    const name = Buffer.from(relative("dist", path).split("\\").join("/"));
    const data = await readFile(path),
      crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const item = Buffer.alloc(46);
    item.writeUInt32LE(0x02014b50);
    item.writeUInt16LE(20, 4);
    item.writeUInt16LE(20, 6);
    item.writeUInt16LE(0x800, 8);
    item.writeUInt16LE(0x21, 14);
    item.writeUInt32LE(crc, 16);
    item.writeUInt32LE(data.length, 20);
    item.writeUInt32LE(data.length, 24);
    item.writeUInt16LE(name.length, 28);
    item.writeUInt32LE(offset, 42);
    central.push(item, name);
    offset += header.length + name.length + data.length;
    count++;
  }
}
await add("dist/gmail-plugin");
const directory = Buffer.concat(central),
  end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(count, 8);
end.writeUInt16LE(count, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
await writeFile("dist/gmail-plugin.zip", Buffer.concat([...local, directory, end]));
