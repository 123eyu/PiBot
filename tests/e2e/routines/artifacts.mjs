import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import prepare from "../../../apps/desktop/scripts/package/prepare-resources.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const desktop = join(root, "apps/desktop");
const out = join(desktop, "out");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const path of [
  "main/index.js",
  "main/brain.js",
  "main/attachment-worker.js",
  "preload/index.cjs",
  "preload/attachments.cjs",
  "renderer/index.html",
])
  await access(join(out, path));
const main = (await readdir(join(out, "main"))).filter((name) => name.endsWith(".js"));
for (const name of main) {
  const code = await readFile(join(out, "main", name), "utf8");
  for (const marker of [
    "createRoutineDevControl",
    "PIBOT_ROUTINE_TEST_ONLY",
    ".pibot-routine-control.json",
  ])
    assert(!code.includes(marker), "Production dev handler must be absent");
}
const migrations = (await readdir(join(root, "packages/storage/migrations")))
  .filter((name) => name.endsWith(".sql"))
  .sort();
assert(migrations.length > 0, "Source migrations must exist");
assert.deepEqual(
  (await readdir(join(out, "migrations"))).filter((name) => name.endsWith(".sql")).sort(),
  migrations,
);
for (const name of migrations)
  assert.equal(
    sha(await readFile(join(out, "migrations", name))),
    sha(await readFile(join(root, "packages/storage/migrations", name))),
  );
const arch = process.arch;
assert(["arm64", "x64"].includes(arch));
const platformKey = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
await prepare({
  packager: { projectDir: desktop, platform: { buildConfigurationKey: platformKey } },
  arch: arch === "arm64" ? 3 : 1,
  electronPlatformName: process.platform,
});
const execRequire = createRequire(join(root, "packages/execution/package.json"));
const policyRequire = createRequire(join(root, "packages/policy/package.json"));
const rgRequire = createRequire(execRequire.resolve("@vscode/ripgrep"));
const binary = process.platform === "win32" ? "rg.exe" : "rg";
const assets = [
  [
    rgRequire.resolve(`@vscode/ripgrep-${process.platform}-${arch}/bin/${binary}`),
    join(out, "native-resources", `${platformKey}-${arch}`, "bin", binary),
  ],
  [
    policyRequire.resolve("web-tree-sitter/web-tree-sitter.wasm"),
    join(out, "native-resources/wasm/web-tree-sitter.wasm"),
  ],
  [
    policyRequire.resolve("tree-sitter-bash/tree-sitter-bash.wasm"),
    join(out, "native-resources/wasm/tree-sitter-bash.wasm"),
  ],
];
for (const [source, target] of assets)
  assert.equal(sha(await readFile(source)), sha(await readFile(target)));
await access(assets[0][1], constants.X_OK);
const manifest = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
for (const [name, version] of [
  ["cron-parser", "5.10.2"],
  ["chokidar", "4.0.3"],
  ["@earendil-works/pi-coding-agent", "1.1.0"],
  ["@anthropic-ai/sandbox-runtime", "0.0.81"],
])
  assert.equal(manifest.dependencies[name], version);
const packaging = await readFile(join(desktop, "electron-builder.yml"), "utf8");
for (const marker of [
  "beforePack",
  "prepare-resources",
  "asarUnpack",
  "vendor",
  "extraResources",
])
  assert(packaging.includes(marker));
console.log(
  JSON.stringify({
    productionDevHandler: "absent",
    migrations: migrations.length,
    resourceHashes: assets.length,
    platform: process.platform,
    arch,
    package: "未验证：合并后负责人adhoc打包",
  }),
);
