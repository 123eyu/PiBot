import { createRequire } from "node:module";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { fail } from "../../../tools/dev/process.ts";
import { failureReason, runSupervised } from "../supervisor.ts";

// Reuse the locked Vite toolchain loader; Node's type stripping cannot load
// workspace classes with parameter properties. No new runtime dependency.
try {
  // Do not pass developer credentials, cloud profiles or OAuth configuration
  // to brain or its SDK. This disposable command never imports environment keys.
  for (const name of Object.keys(process.env)) {
    if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
      delete process.env[name];
  }
  if (isMainThread) {
    const results = await runSupervised({ scenario: process.argv[2] });
    // Passing output is published only after executor exit and directory deletion.
    for (const result of results) console.log(JSON.stringify(result));
  } else {
    const desktop = createRequire(
      new URL("../../../apps/desktop/package.json", import.meta.url),
    );
    const vite = createRequire(desktop.resolve("vite/package.json"));
    const { createJiti } = vite("jiti");
    const loader = createJiti(import.meta.url, { fsCache: false });
    const { runAcceptance } = await loader.import("./runner.ts");
    const results = await runAcceptance(workerData.root);
    parentPort?.postMessage({ type: "done", results });
  }
} catch (error) {
  if (isMainThread) fail(error);
  else parentPort?.postMessage({ type: "failed", reason: failureReason(error) });
} finally {
  if (!isMainThread) parentPort?.close();
}
