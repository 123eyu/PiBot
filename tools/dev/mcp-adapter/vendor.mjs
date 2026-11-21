// Fixed, read-only upstream source capture for reproducible derivation; never executes upstream code.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const sha = "efe943e637e503e10af382d0ace1aec834989c69";
const root = resolve("tools/vendor/pi-mcp-adapter");
const files = ["LICENSE", "host-managed.ts", "proxy-modes.ts", "search-ranking.ts", "tool-metadata.ts", "metadata-cache.ts", "config.ts", "agent-plugin-loader.ts", "json-schema-validator.ts", "tool-parameters.ts", "tool-registrar.ts", "mcp-output-guard.ts", "utils.ts", "types.ts", "abort.ts", "runtime-owner.ts"];
await mkdir(root, { recursive: true });
const manifest = { repository: "https://github.com/nicobailon/pi-mcp-adapter", version: "5.3.1", commit: sha, files: {} };
for (const file of files) {
  const response = await fetch(`https://raw.githubusercontent.com/nicobailon/pi-mcp-adapter/${sha}/${file}`, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new Error(`Source capture failed: ${file} HTTP ${response.status}`);
  const content = await response.text();
  if (Buffer.byteLength(content) > 512 * 1024) throw new Error("Source capture too large");
  await writeFile(join(root, file === "LICENSE" ? file : `${file}.txt`), content, { flag: "wx" });
  manifest.files[file] = createHash("sha256").update(content).digest("hex");
}
await writeFile(join(root, "source.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(manifest));
