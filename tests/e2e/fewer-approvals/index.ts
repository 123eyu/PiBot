import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "../../../tools/dev/process.ts";

// Probe: which steps still show an approval card. Read-only commands in the work folder,
// in-folder reads, a public page read after "read public pages" is remembered, and a second read
// in an outside folder allowed once run without a card (each audited as an automatic approval);
// rm, a connector send still ask, and a write outside the work folder asks once
// (not rememberable) and is refused when denied.
// Run: node tests/e2e/fewer-approvals/index.ts
// Output: tool names, categories and reason codes only, never prompts, replies, paths or keys.
for (const name of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
    delete process.env[name];
}
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-fewer-approvals-")));
try {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const loader = createJiti(import.meta.url, { fsCache: false });
  const { runFewerApprovalsProbe } = await loader.import("./probe.ts");
  console.log(JSON.stringify(await runFewerApprovalsProbe(root), null, 2));
} catch (error) {
  fail(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
