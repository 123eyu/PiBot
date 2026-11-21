import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { faceSvg, readLogoSource } from "./logo-source.ts";

const logo = readLogoSource();
const directory = fileURLToPath(new URL("../../resources/", import.meta.url));
mkdirSync(directory, { recursive: true });
function renderColor(name: string, size: number, logicalSize = size) {
  const width = logicalSize <= logo.smallSize ? logo.smallFaceWidth : logo.faceWidth;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"><path d="${logo.blob}" fill="${logo.fill}" stroke="${logo.fill}" stroke-width="${logo.bodyWidth}" stroke-linejoin="round"/>${faceSvg(logo.paths, logo.ink, width)}</svg>`;
  writeFileSync(join(directory, name), new Resvg(svg).render().asPng());
}
function render(name: string, size: number, ink: string, logicalSize = size) {
  const width = logicalSize <= logo.smallSize ? logo.smallFaceWidth : logo.faceWidth;
  // Luminance masks remove eye pixels entirely, including on a dark menu bar.
  const mask = `<mask id="eyes" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="#ffffff"/>${faceSvg(logo.paths, "#000000", width)}</mask>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"><defs>${mask}</defs><path d="${logo.blob}" fill="${ink}" stroke="${ink}" stroke-width="${logo.bodyWidth}" stroke-linejoin="round" mask="url(#eyes)"/></svg>`;
  writeFileSync(join(directory, name), new Resvg(svg).render().asPng());
}
// Electron loads the matching @2x file automatically for macOS template images.
render("trayTemplate.png", 16, "#000000");
render("trayTemplate@2x.png", 32, "#000000", 16);
for (const size of [16, 18, 22]) {
  render(`trayTemplate-${size}.png`, size, "#000000");
  render(`trayTemplate-${size}@2x.png`, size * 2, "#000000", size);
}
for (const theme of ["light", "dark"]) {
  for (const size of [16, 18, 22, 24, 32]) {
    const ink = theme === "dark" ? "#ffffff" : "#000000";
    render(`tray-${theme}-${size}.png`, size, ink);
    render(`tray-${theme}-${size}@2x.png`, size * 2, ink, size);
  }
}
// Windows shows the full-colour logo (maintainers 2026-11-11); the violet reads on light and dark taskbars.
for (const size of [16, 24, 32]) renderColor(`tray-color-${size}.png`, size);
