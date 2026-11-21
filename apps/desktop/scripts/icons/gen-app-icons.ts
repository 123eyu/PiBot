// Keep platform icon shapes separate so macOS padding never reaches mobile or Windows.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { faceSvg, readLogoSource } from "./logo-source.ts";

const logo = readLogoSource();

// Two symmetric cubic segments meet each straight edge with zero curvature.
function macOutline() {
  const radius = 185;
  const corners = [
    [739, 100, 1, 0],
    [924, 739, 0, 1],
    [285, 924, -1, 0],
    [100, 285, 0, -1],
  ];
  const commands = ["M285 100 L739 100"];
  for (const [x = 0, y = 0, dx = 0, dy = 0] of corners) {
    const point = (u: number, v: number) =>
      `${x + radius * (u * dx - v * dy)} ${y + radius * (u * dy + v * dx)}`;
    commands.push(
      `C${point(0.5, 0)} ${point(Math.SQRT1_2, 0)} ${point((1 + Math.SQRT1_2) / 2, (1 - Math.SQRT1_2) / 2)}`,
      `C${point(1, 1 - Math.SQRT1_2)} ${point(1, 0.5)} ${point(1, 1)}`,
    );
    if (dx === 1) commands.push("L924 739");
    else if (dy === 1) commands.push("L285 924");
    else if (dx === -1) commands.push("L100 285");
  }
  return `${commands.join(" ")} Z`;
}

/** Mixes the brand colour toward white (amount > 0) or black (amount < 0). */
function shade(hex: string, amount: number) {
  const value = Number.parseInt(hex.slice(1), 16);
  const target = amount > 0 ? 255 : 0;
  const channel = (shift: number) => {
    const c = (value >> shift) & 255;
    return Math.round(c + (target - c) * Math.abs(amount))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/**
 * Maintainers 2026-11-19: macOS 15 and earlier draw the file as is, so the look macOS 26 gives an icon
 * (rounded body, light rim brighter at the top, gentle gradient, soft shadow) is drawn in here.
 */
function macSvg(size: number, faceWidth: number, viewBox = "0 0 1024 1024") {
  const outline = macOutline();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${size}" height="${size}">
<defs>
<linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(logo.fill, 0.12)}"/><stop offset="1" stop-color="${shade(logo.fill, -0.06)}"/></linearGradient>
<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.7"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0.25"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.4"/></linearGradient>
<clipPath id="inside"><path d="${outline}"/></clipPath>
<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000000" flood-opacity="0.28"/></filter>
</defs>
<path d="${outline}" fill="url(#body)" filter="url(#shadow)"/>
<path d="${outline}" fill="none" stroke="url(#rim)" stroke-width="12" clip-path="url(#inside)"/>
<g transform="translate(100 100) scale(8.24)">${faceSvg(logo.paths, logo.ink, faceWidth)}</g>
</svg>`;
}

const build = fileURLToPath(new URL("../../build/", import.meta.url));
const sizes = [1024, 512, 256, 128, 64, 32, 16];
for (const [platform, shape] of [
  ["mac", logo.square],
  ["win", logo.blob],
  ["linux", logo.circle],
] as const) {
  const directory = join(build, "icons", platform);
  mkdirSync(directory, { recursive: true });
  for (const size of sizes) {
    const faceWidth = size <= logo.smallSize ? logo.smallFaceWidth : logo.faceWidth;
    const bodyWidth = platform === "win" ? logo.bodyWidth : 0;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"><path d="${shape}" fill="${logo.fill}" stroke="${logo.fill}" stroke-width="${bodyWidth}" stroke-linejoin="round"/>${faceSvg(logo.paths, logo.ink, faceWidth)}</svg>`;
    const png = new Resvg(platform === "mac" ? macSvg(size, faceWidth) : svg, {
      font: { loadSystemFonts: false },
    })
      .render()
      .asPng();
    writeFileSync(join(directory, `${size}x${size}.png`), png);
  }
}

// The browser extension shows the same icon; cropped closer so it is not small in the toolbar.
const extension = fileURLToPath(new URL("../../../browser-extension/icons/", import.meta.url));
mkdirSync(extension, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const faceWidth = size <= logo.smallSize ? logo.smallFaceWidth : logo.faceWidth;
  const png = new Resvg(macSvg(size, faceWidth, "70 70 884 884"), {
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  writeFileSync(join(extension, `icon-${size}.png`), png);
}

// ICO supports PNG payloads; no native image conversion dependency is needed.
const icoSizes = sizes.filter((size) => size <= 256);
const header = Buffer.alloc(6 + 16 * icoSizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);
const payloads: Buffer[] = [];
let offset = header.length;
for (const [index, size] of icoSizes.entries()) {
  const png = readFileSync(join(build, "icons", "win", `${size}x${size}.png`));
  const entry = 6 + 16 * index;
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  payloads.push(png);
  offset += png.length;
}
writeFileSync(join(build, "icon.ico"), Buffer.concat([header, ...payloads]));
