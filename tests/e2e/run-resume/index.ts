import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "../../../tools/dev/process.ts";

// Probe: interrupted runs and 「继续」 on the real brain with the fake model, plus a
// resume whose earlier write_file is done. A crash is reproduced by copying the
// database and session files while a call is in flight, stopping, and starting again from them.
// Run: node tests/e2e/run-resume/index.ts
// Output: structural facts only (states, counts), never prompts, replies or keys.
for (const name of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
    delete process.env[name];
}
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-resume-")));
try {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const loader = createJiti(import.meta.url, { fsCache: false });
  const { runResumeProbe } = await loader.import("./probe.ts");
  console.log(JSON.stringify(await runResumeProbe(root), null, 2));
} catch (error) {
  fail(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
