// The source package Mozilla's reviewers rebuild the .xpi from: this extension, the two workspace
// packages its bundle includes, the theme tokens it copies, and npm-only package files (pnpm's
// workspace: ranges become plain versions) with esbuild and zod pinned to the versions in use.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { zip } from "./scripts-package.mjs";

const repo = join(import.meta.dirname, "..", "..");
const { version } = JSON.parse(await readFile("manifest.json", "utf8"));
const ESBUILD = "0.28.2";

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !["node_modules", "dist", ".cache"].includes(entry.name))
      .map((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      ),
  );
  return nested.flat();
}
const npmPackage = (raw) => {
  const value = JSON.parse(raw);
  for (const field of ["dependencies", "devDependencies"])
    for (const [name, range] of Object.entries(value[field] ?? {}))
      if (range.startsWith("workspace:")) value[field][name] = range.slice("workspace:".length);
  delete value.devDependencies;
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
};

const files = [
  ...(await walk(join(repo, "apps/browser-extension"))).filter(
    (path) => !/scripts-source\.mjs$|tsconfig|[\\/]\.cache[\\/]/.test(path),
  ),
  ...(await walk(join(repo, "packages/browser-contract/src"))),
  join(repo, "packages/browser-contract/package.json"),
  ...(await walk(join(repo, "packages/protocol-base/src"))).filter(
    (path) => !/\.test\.ts$/.test(path),
  ),
  join(repo, "packages/protocol-base/package.json"),
  join(repo, "packages/ui/src/theme/tokens.css"),
  join(repo, "LICENSE"),
];
const entries = [];
for (const path of files.sort()) {
  const name = relative(repo, path).split(sep).join("/");
  const data = await readFile(path);
  entries.push({ name, data: name.endsWith("package.json") ? npmPackage(data) : data });
}
entries.push({
  name: "package.json",
  data: Buffer.from(
    `${JSON.stringify(
      {
        private: true,
        workspaces: [
          "apps/browser-extension",
          "packages/browser-contract",
          "packages/protocol-base",
        ],
        devDependencies: { esbuild: ESBUILD },
        scripts: { build: "npm run build -w @pibot/browser-extension" },
      },
      null,
      2,
    )}\n`,
  ),
});
entries.push({
  name: "README-BUILD.md",
  data: Buffer.from(`# Pi Bot Browser ${version}: build from source

Requirements: Node.js 22 or later, npm (macOS, Windows or Linux).

    npm install
    npm run build

The add-on is written to \`apps/browser-extension/dist/firefox/\`; its files are those of the
submitted pibot-browser-firefox-${version}.xpi. esbuild ${ESBUILD} bundles \`src/background.ts\`,
\`src/content.ts\` and \`src/popup.ts\` (TypeScript, not minified) with the workspace packages
\`@pibot/browser-contract\` and \`@pibot/protocol-base\` and zod; \`scripts-build.mjs\` writes the
manifest and copies the popup, icons and theme tokens. No other code is generated or downloaded.
`),
});
const file = `pibot-browser-firefox-${version}-source.zip`;
await writeFile(join("dist", file), zip(entries.sort((a, b) => a.name.localeCompare(b.name))));
console.log(`dist/${file} (${entries.length} files)`);
