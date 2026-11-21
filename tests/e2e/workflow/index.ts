import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "../../../tools/dev/process.ts";

// Probe: a workflow skill (work contract) through `skills.runWorkflow`: a
// pre-check failure that starts nothing, a run fixed in one delivery round and a run that
// stays failing (交付未通过) with the missing item in its receipt.
// Run: node tests/e2e/workflow/index.ts
// Output: structural numbers only (counts, timings), never prompts, replies or keys.
for (const name of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
    delete process.env[name];
}
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-workflow-")));
try {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const loader = createJiti(import.meta.url, { fsCache: false });
  const { runWorkflowProbe } = await loader.import("./probe.ts");
  console.log(JSON.stringify(await runWorkflowProbe(root), null, 2));
} catch (error) {
  fail(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
