import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "../../../tools/dev/process.ts";

// Web probe: a stubbed 120k-character page is fetched through the real web_fetch path (policy,
// approval, audit). With a question the auxiliary model's short extract is the tool result and its
// request counts in the run budget and receipt; `full: true` returns the raw page; an auxiliary
// failure falls back to the raw page.
// Run: node tests/e2e/web-extract/index.ts
// Output: structural numbers only (sizes, counts, timings), never prompts, replies or keys.
for (const name of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
    delete process.env[name];
}
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-web-extract-")));
try {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const loader = createJiti(import.meta.url, { fsCache: false });
  const { runWebExtractProbe } = await loader.import("./probe.ts");
  console.log(JSON.stringify(await runWebExtractProbe(root), null, 2));
} catch (error) {
  fail(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
