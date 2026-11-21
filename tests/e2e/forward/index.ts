import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "../../../tools/dev/process.ts";

// FORWARD-DISPLAY probe: forwarding selected messages (with a note and a handoff summary) to a Bot
// and (without a note) to a group. The model request text must equal the pre-change formula byte
// for byte; the stored user message carries usage.forward; bubble, copy, input history and
// "retry from here" drafts use the note only.
// Run: node tests/e2e/forward/index.ts [--baseline]
// --baseline checks only the model text formula, so the same probe can run on older code.
// Output: structural facts only (lengths, hashes, booleans), never prompts or replies.
for (const name of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
    delete process.env[name];
}
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-forward-")));
try {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const loader = createJiti(import.meta.url, { fsCache: false });
  const { runForwardProbe } = await loader.import("./probe.ts");
  const baseline = process.argv.includes("--baseline");
  console.log(JSON.stringify(await runForwardProbe(root, baseline), null, 2));
} catch (error) {
  fail(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
