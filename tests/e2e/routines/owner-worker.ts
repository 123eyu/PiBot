import { createRequire } from "node:module";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
const { createJiti } = createRequire(desktop.resolve("vite/package.json"))("jiti");
// Progress steps let the parent measure an idle deadline instead of a fixed cold-start budget.
const progress = (step: string) => parentPort?.postMessage({ status: "progress", step });
try {
  progress("bootstrap");
  // The restart check starts four fresh owners; each re-transpiled the whole module
  // graph, ~14 s apiece, which alone pushed the suite past its 300 s deadline. A transpile cache
  // scoped to this run's temporary root (removed with it, keyed by source content) lets owners
  // two to four reuse the first one's output; what they execute is unchanged.
  const { runOwner } = await createJiti(import.meta.url, {
    fsCache: join(String(workerData.temporaryRoot), "jiti-cache"),
  }).import("./owner-runner.ts");
  progress("imported");
  await runOwner(workerData, progress);
  // Cleanup completed; terminate remaining HTTP client idle handles in this isolated owner.
  process.exit(0);
} catch {
  parentPort?.postMessage({ status: "failed" });
} finally {
  parentPort?.close();
}
