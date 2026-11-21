// Packs each built browser folder into the single file its store takes: a .zip for the Chrome Web
// Store and Edge Add-ons, an .xpi for Mozilla's signing. Node's zlib only (no zip dependency), and
// fixed timestamps and order so the same build always gives the same bytes on every platform.
// Run after `pnpm build`; `pnpm package` does both.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const { version } = JSON.parse(await readFile("manifest.json", "utf8"));
const targets = [
  { browser: "chrome", file: `pibot-browser-chrome-${version}.zip` },
  // The Chrome Web Store and Edge Add-ons refuse a manifest `key` and assign the item its own id.
  { browser: "chrome", file: `pibot-browser-chrome-${version}-store.zip`, store: true },
  { browser: "firefox", file: `pibot-browser-firefox-${version}.xpi` },
];

async function files(root, dir = root) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? files(root, join(dir, entry.name)) : [join(dir, entry.name)],
    ),
  );
  return nested.flat();
}

/** A minimal deflate zip: local headers, data, central directory, end record. */
export function zip(entries) {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, the earliest a zip can say
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const path = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, path, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, path);
    offset += local.length + path.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Imported by scripts-source.mjs for zip() alone.
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href)
  for (const { browser, file, store } of targets) {
    const root = join("dist", browser);
    const paths = (await files(root)).sort();
    const entries = await Promise.all(
      paths.map(async (path) => ({
        // Zip names always use "/", whatever the platform's separator.
        name: relative(root, path).split(sep).join("/"),
        data: await readFile(path),
      })),
    );
    if (store)
      for (const entry of entries)
        if (entry.name === "manifest.json") {
          const manifest = JSON.parse(entry.data.toString("utf8"));
          delete manifest.key;
          entry.data = Buffer.from(JSON.stringify(manifest, null, 2));
        }
    if (!entries.some((entry) => entry.name === "manifest.json"))
      throw new Error(`${browser}: manifest.json missing; run pnpm build first`);
    await writeFile(join("dist", file), zip(entries));
    console.log(`dist/${file} (${entries.length} files)`);
  }
