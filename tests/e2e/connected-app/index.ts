import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "../../../tools/dev/process.ts";

// Exercise a connected app through the production brain assembly and a fake native host.
// Run: node tests/e2e/connected-app/index.ts
// Output: structural assertions only; no prompt, event body, credential or local path is printed.
for (const name of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
    delete process.env[name];
}
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-connected-app-")));
try {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const loader = createJiti(import.meta.url, { fsCache: false });
  const { runConnectedAppProbe, runConnectionToolGrantProbe } = await loader.import("./probe.ts");
  console.log(JSON.stringify(await runConnectedAppProbe(root), null, 2));
  console.log(JSON.stringify(await runConnectionToolGrantProbe(root), null, 2));
} catch (error) {
  fail(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
