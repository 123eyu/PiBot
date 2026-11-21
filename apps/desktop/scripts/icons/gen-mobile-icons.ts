import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { faceSvg, readLogoSource } from "./logo-source.ts";

// Phone icons from the same logo source as the desktop icons (apps/mobile/app.config.ts).
const logo = readLogoSource();
const out = fileURLToPath(new URL("../../../mobile/assets/", import.meta.url));
mkdirSync(out, { recursive: true });
const render = (svg: string) =>
  new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();

// App icon: full-bleed brand square with the face; stores and launchers apply their own mask.
writeFileSync(
  join(out, "icon.png"),
  render(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1024" height="1024"><rect width="100" height="100" fill="${logo.fill}"/>${faceSvg(logo.paths, logo.ink, logo.faceWidth)}</svg>`,
  ),
);
// Android adaptive foreground: the face only, scaled into the 66% safe zone of a 108dp canvas.
writeFileSync(
  join(out, "adaptive-icon.png"),
  render(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1024" height="1024"><g transform="translate(20 20) scale(0.6)">${faceSvg(logo.paths, logo.ink, logo.faceWidth)}</g></svg>`,
  ),
);
console.log(`Wrote icon.png and adaptive-icon.png to ${out} (background ${logo.fill})`);
