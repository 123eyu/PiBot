import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageArch } from "./package-options.ts";
import { verifyTargetBinary } from "./verify-target-binary.ts";

/**
 * Option a: the helper Node is in resources/bin for the target, and every child entry
 * with its chunks and dependencies is unpacked where that helper (which cannot read asar) finds
 * it, including the ESM marker.
 */
export function verifyChildNode(resources: string, platform: string, arch: PackageArch) {
  const helper = join(resources, "bin", platform === "win32" ? "node.exe" : "node");
  assert(existsSync(helper), "Missing helper Node");
  verifyTargetBinary(helper, platform, arch);
  assert(existsSync(join(resources, "bin", "node-LICENSE")), "Missing helper Node licence");
  const unpacked = join(resources, "app.asar.unpacked");
  assert.equal(
    readFileSync(join(unpacked, "out", "main", "package.json"), "utf8").trim(),
    '{ "type": "module" }',
    "Unpacked child entries need their ESM marker",
  );
  const entries = [
    "sandbox-host.js",
    "sandbox-doctor.js",
    "violation-log.js",
    "plugin-calendar-server.js",
    "plugin-contacts-server.js",
    "pibot-mcp-bridge.js",
    ...(platform === "linux" ? ["linux-sandbox-check.js"] : []),
  ];
  for (const entry of entries)
    assert(existsSync(join(unpacked, "out", "main", entry)), `Child entry not unpacked: ${entry}`);
  assert(
    existsSync(join(unpacked, "node_modules", "@anthropic-ai", "sandbox-runtime", "dist")),
    "Sandbox runtime JavaScript must be unpacked for the helper Node",
  );
}
