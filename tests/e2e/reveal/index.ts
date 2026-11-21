import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "../../../tools/dev/process.ts";

// Reveal probe: a Bot shows a folder and a file inside its own folder through reveal_in_folder
// (stubbed host.revealPath records the call), while a folder outside the boundary and a link that
// leads out are refused by policy without an approval card. Also checks that computer-use
// open_file on a folder answers with the reveal_in_folder hint.
// Run: node tests/e2e/reveal/index.ts
// Output: structural facts only (statuses, counts), never prompts, replies or keys.
for (const name of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
    delete process.env[name];
}
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-reveal-")));
try {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const loader = createJiti(import.meta.url, { fsCache: false });
  const { runRevealProbe } = await loader.import("./probe.ts");
  console.log(JSON.stringify(await runRevealProbe(root), null, 2));
} catch (error) {
  fail(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
