import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "../../../tools/dev/process.ts";

// Cache probe: drives the real brain + agent runtime through a DM (two runs, several tool calls,
// a plan update) and a group run, against the local fake model on both the Chat Completions and
// the Responses wire format, captures every request body and diffs consecutive requests of the
// same Bot: longest common prefix, first differing byte and what sits there. The Responses rows
// also show the ChatGPT (Codex) adapter's shape (system prompt as `instructions`), which is built
// from the same transcript by the same pi-ai converter. The Responses rows also assert that
// every request of a run extends the previous one item for item (append-only states), simulate
// both cache rules, and a budget run checks that the program, not the model, enforces limits.
// Run: node tests/e2e/cache/index.ts [--verbose]
// Output: synthetic fixture text only (no real prompts, keys or user data exist here).
for (const name of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
    delete process.env[name];
}
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-cache-")));
try {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const loader = createJiti(import.meta.url, { fsCache: false });
  const replay = process.argv.indexOf("--replay");
  if (replay > 0) {
    const file = process.argv[replay + 1];
    if (!file) throw new Error("--replay needs a session .jsonl path");
    const { replaySession } = await loader.import("./replay.ts");
    const group = process.argv.find((arg) => arg === "--group" || arg.startsWith("--group="));
    console.log(
      await replaySession(
        file,
        group === undefined ? false : group === "--group" ? "fit" : Number(group.slice(8)),
        process.argv.includes("--rule=guide") ? "guide" : "trailing",
      ),
    );
  } else {
    const { runCacheProbe } = await loader.import("./probe.ts");
    console.log(await runCacheProbe(root, process.argv.includes("--verbose")));
  }
} catch (error) {
  fail(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
