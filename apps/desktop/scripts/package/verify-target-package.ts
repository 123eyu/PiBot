import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFile, listPackage } from "@electron/asar";
import { appRun, linuxLauncher } from "./linux-launcher.mjs";
import { packagedElectron, verifyPackageFuses } from "./package-fuses.ts";
import {
  assertApplicationFiles,
  assertTargetNativeFiles,
  type PackageArch,
  type PackageMode,
} from "./package-options.ts";
import { verifyChildNode } from "./verify-child-node.ts";
import { verifyNativePrebuilds } from "./verify-native-prebuilds.ts";
import { verifyCodeMapGrammars, verifySemanticLibraries } from "./verify-semantic-libraries.ts";
import { verifyTargetBinary } from "./verify-target-binary.ts";

export async function verifyTargetPackage(
  directory: string,
  platform: string,
  arch: PackageArch,
  mode: PackageMode = "test",
) {
  await verifyPackageFuses(packagedElectron(directory, platform), mode);
  const resources = join(directory, "resources");
  const archive = join(resources, "app.asar");
  assert.equal(
    JSON.parse(extractFile(archive, "package.json").toString()).pibotBuildMode,
    mode,
    "Wrong package mode",
  );
  const files = new Set(
    listPackage(archive, { isPack: false }).map((file) => file.replaceAll("\\", "/")),
  );
  assertApplicationFiles([...files]);
  const packagePlatform = platform === "win32" ? "win" : "linux";
  assertTargetNativeFiles([...files], packagePlatform, arch);
  verifyNativePrebuilds(archive, platform, arch);
  verifySemanticLibraries(archive, [...files]);
  for (const name of [
    "out/main/index.js",
    "out/main/brain.js",
    "out/main/sandbox-host.js",
    "out/main/violation-log.js",
    "out/main/plugin-calendar-server.js",
    "out/main/plugin-contacts-server.js",
    // The `pibot` MCP relay external agents start.
    "out/main/pibot-mcp-bridge.js",
    "out/preload/index.cjs",
    "out/renderer/index.html",
  ])
    assert(files.has(`/${name}`), `Missing entry: ${name}`);
  const win = platform === "win32";
  assert(existsSync(join(directory, win ? "Pi Bot.exe" : "pi-bot")), "Missing target executable");
  verifyTargetBinary(packagedElectron(directory, platform), platform, arch);
  if (!win) {
    assert(files.has("/out/main/linux-sandbox-check.js"), "Missing Linux sandbox gate");
    assert.equal(
      readFileSync(join(directory, "pi-bot"), "utf8"),
      linuxLauncher,
      "Wrong Linux launcher",
    );
    assert.equal(readFileSync(join(directory, "AppRun"), "utf8"), appRun, "Unsafe AppRun");
  }
  verifyTargetBinary(join(resources, "bin", win ? "rg.exe" : "rg"), platform, arch);
  verifyChildNode(resources, platform, arch);
  if (win) {
    // Bundled MinGit: runtime resolves bin/git/cmd/git.exe after any installed Git.
    verifyTargetBinary(join(resources, "bin", "git", "cmd", "git.exe"), platform, arch);
    assert(existsSync(join(resources, "bin", "git", "LICENSE.txt")), "Missing MinGit licence");
    assert(existsSync(join(resources, "licenses", "mingit.md")), "Missing MinGit notice");
  }
  verifyCodeMapGrammars(join(resources, "wasm", "codemap"));
  for (const name of ["web-tree-sitter.wasm", "tree-sitter-bash.wasm"])
    assert(
      WebAssembly.validate(readFileSync(join(resources, "wasm", name))),
      `Invalid WASM: ${name}`,
    );
  for (const plugin of ["calendar", "contacts"])
    assert(
      existsSync(join(resources, "plugins", plugin, "pibot.json")),
      `Missing declarative plugin: ${plugin}`,
    );
  const suffix = win ? "msvc" : "gnu";
  const cua = join(
    `${archive}.unpacked`,
    "node_modules",
    "@trycua",
    `cua-driver-${platform}-${arch}-${suffix}`,
  );
  for (const name of win
    ? ["cua_driver_sdk.dll", "cua_driver_node_runtime.node"]
    : ["libcua_driver_sdk.so", "cua_driver_node_runtime.node"])
    assert(existsSync(join(cua, name)), `Missing target Cua file: ${name}`);
  assert(existsSync(join(resources, "licenses", "MPL-2.0.txt")), "Missing native license");
  console.info(
    `Verified packaged entries and resources: ${platform}-${arch}. Target OS runtime acceptance is still required.`,
  );
}
