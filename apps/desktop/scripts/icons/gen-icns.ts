// Write standard PNG-backed ICNS slots without depending on the host's iconutil service.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const build = fileURLToPath(new URL("../../build/", import.meta.url));
// Include both logical sizes and Retina slots, preserving each PNG's alpha channel.
const slots = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
] as const;
const chunks = slots.map(([type, size]) => {
  const png = readFileSync(join(build, "icons", "mac", `${size}x${size}.png`));
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(header.length + png.length, 4);
  return Buffer.concat([header, png]);
});
const header = Buffer.alloc(8);
header.write("icns", 0, 4, "ascii");
header.writeUInt32BE(header.length + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
writeFileSync(join(build, "icon.icns"), Buffer.concat([header, ...chunks]));
