import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "../../../tools/dev/process.ts";

// Probe: structured group hand-offs. A 3-stage pipeline with expected files runs past
// the automatic round limit; a result missing its expected file is sent back once, then the
// group stops for the user; plain assignments (free discussion) still stop at the round limit.
// Run: node tests/e2e/handoff/index.ts
// Output: structural numbers only (counts, timings), never prompts, replies or keys.
for (const name of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
    delete process.env[name];
}
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-handoff-")));
try {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const loader = createJiti(import.meta.url, { fsCache: false });
  const { runHandoffProbe } = await loader.import("./probe.ts");
  console.log(JSON.stringify(await runHandoffProbe(root), null, 2));
} catch (error) {
  fail(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
