import { createRequire } from "node:module";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { fail } from "../../../tools/dev/process.ts";
import { failureReason, runSupervised } from "../supervisor.ts";

try {
  for (const name of Object.keys(process.env))
    if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
      delete process.env[name];
  if (isMainThread) {
    const entry = new URL("./index.ts", import.meta.url);
    const phases = ["scheduler", "pause-folders", "ledger"];
    if (process.argv[2] && !phases.includes(process.argv[2])) throw new Error("Unknown routines phase");
    // Each supervised phase has its own deadline: the phases below wait on real debounce, cooldown
    // and one-minute cron timers (~135 s), and this phase also restarts owners that re-transpile
    // the module graph. The suite ran out of a 300 s budget whenever the machine was also running
    // two verifies and a Bot, so the per-phase budgets were raised. Assertions unchanged.
    const results = process.argv[2] ? [] : await runSupervised({ entry, deadlineMs: 900_000 });
    for (const scenario of process.argv[2] ? [process.argv[2]] : phases)
      results.push(...(await runSupervised({ entry, scenario })));
    for (const result of results) console.log(JSON.stringify(result));
  } else {
    const desktop = createRequire(
      new URL("../../../apps/desktop/package.json", import.meta.url),
    );
    const vite = createRequire(desktop.resolve("vite/package.json"));
    const { createJiti } = vite("jiti");
    const { runM3Acceptance } = await createJiti(import.meta.url, { fsCache: false }).import(
      "./runner.ts",
    );
    parentPort?.postMessage({
      type: "done",
      results: await runM3Acceptance(workerData.root, process.argv[2]),
    });
  }
} catch (error) {
  if (isMainThread) fail(error);
  else parentPort?.postMessage({ type: "failed", reason: failureReason(error) });
} finally {
  if (!isMainThread) parentPort?.close();
}
