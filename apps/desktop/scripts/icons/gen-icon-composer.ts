// Maintainers 2026-11-19: macOS 26 puts an icon that draws its own rounded shape inside a grey tile,
// and macOS 15 shows a full-bleed square as a square. An Icon Composer icon serves both: macOS 26
// renders its layers (shape, rim, depth) itself and earlier versions get the rounded images
// actool pre-renders from it. The layers are the brand fill and the face, nothing drawn on top.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { faceSvg, readLogoSource } from "./logo-source.ts";

const logo = readLogoSource();
const output = fileURLToPath(new URL("../../build/icon.icon/", import.meta.url));
rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, "Assets"), { recursive: true });

const channel = (hex: string, at: number) =>
  (Number.parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(5);
const srgb = (hex: string) =>
  `srgb:${channel(hex, 1)},${channel(hex, 3)},${channel(hex, 5)},1.00000`;

// The face on the full transparent canvas, as in the full-bleed square the app shipped with
// before. A PNG, because Icon Composer crops an SVG layer's stroke ends to the path bounds.
const face = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1024" height="1024">${faceSvg(logo.paths, logo.ink, logo.faceWidth)}</svg>`;
writeFileSync(
  join(output, "Assets", "face.png"),
  new Resvg(face, { font: { loadSystemFonts: false } }).render().asPng(),
);
writeFileSync(
  join(output, "icon.json"),
  `${JSON.stringify(
    {
      fill: { solid: srgb(logo.fill) },
      groups: [
        {
          // Solid white eyes, as on the old icon: no glass or translucency on the face.
          layers: [{ "image-name": "face.png", name: "face", glass: false }],
          shadow: { kind: "none", opacity: 0 },
          specular: false,
          translucency: { enabled: false, value: 0 },
        },
      ],
      "supported-platforms": { squares: ["macOS"] },
    },
    null,
    2,
  )}\n`,
);

// Compile once here and commit the results, so packaging needs no Xcode: Assets.car for macOS 11+
// (macOS 26 renders the layers, earlier versions use the rounded images actool pre-renders) and
// the matching icon.icns for anything older.
const developer = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
if (!existsSync(join(developer, "usr/bin/actool")))
  throw new Error("gen-icon-composer: Xcode 26 or later is needed (set DEVELOPER_DIR)");
const build = fileURLToPath(new URL("../../build/", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "pibot-icon-"));
const run = (file: string, args: string[]) =>
  execFileSync(file, args, { env: { ...process.env, DEVELOPER_DIR: developer }, stdio: "pipe" });
run("xcrun", [
  "actool",
  output,
  "--compile",
  work,
  "--platform",
  "macosx",
  "--minimum-deployment-target",
  "11.0",
  "--app-icon",
  "icon",
  "--output-partial-info-plist",
  join(work, "partial.plist"),
]);
copyFileSync(join(work, "Assets.car"), join(build, "Assets.car"));
copyFileSync(join(work, "icon.icns"), join(build, "icon.icns"));
// The extension's toolbar icons use the same rendering (the icns holds it up to 256 px).
run("iconutil", ["-c", "iconset", join(work, "icon.icns"), "-o", join(work, "icon.iconset")]);
const rendered = join(work, "icon.iconset", "icon_128x128@2x.png");
const extension = fileURLToPath(new URL("../../../browser-extension/icons/", import.meta.url));
const cropped = join(work, "toolbar.png");
// Apple's icon grid leaves a 100/1024 margin; the toolbar shows the body closer (884/1024).
run("sips", ["-c", "221", "221", rendered, "--out", cropped]);
for (const size of [16, 32, 48, 128])
  run("sips", [
    "-z",
    String(size),
    String(size),
    cropped,
    "--out",
    join(extension, `icon-${size}.png`),
  ]);
rmSync(work, { recursive: true, force: true });
console.log("icon.icon compiled: Assets.car, icon.icns, extension icons");
