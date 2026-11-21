import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "../../../tools/dev/process.ts";

// Probe: one scripted DM run (write a file, read it, run a command behind an approval,
// record an unverified item), then compare `runs.receipt` with the audit, changes and budget
// records it claims to summarize, and check it carries no message text or file content.
// Run: node tests/e2e/receipt/index.ts
// Output: structural numbers only (counts, timings), never prompts, replies or keys.
for (const name of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
    delete process.env[name];
}
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-receipt-")));
try {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const loader = createJiti(import.meta.url, { fsCache: false });
  const { runReceiptProbe } = await loader.import("./probe.ts");
  console.log(JSON.stringify(await runReceiptProbe(root), null, 2));
} catch (error) {
  fail(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
