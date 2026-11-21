import { createRequire } from "node:module";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { fail } from "../../../tools/dev/process.ts";
import { failureReason, runSupervised } from "../supervisor.ts";

try {
  for (const name of Object.keys(process.env))
    if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
      delete process.env[name];
  if (isMainThread) {
    const results = await runSupervised({ entry: new URL("./index.ts", import.meta.url) });
    for (const result of results) console.log(JSON.stringify(result));
  } else {
    const desktop = createRequire(
      new URL("../../../apps/desktop/package.json", import.meta.url),
    );
    const vite = createRequire(desktop.resolve("vite/package.json"));
    const loader = vite("jiti").createJiti(import.meta.url, { fsCache: false });
    const { runCompactionReliability } = await loader.import("../compaction-reliability.ts");
    const { runCompactionControls, runCompactionProgress, runRoutineCompaction } =
      await loader.import("../compaction-controls.ts");
    const checks = [
      ...(await runCompactionReliability()),
      ...(await runCompactionControls(workerData.root)),
      ...(await runCompactionProgress(workerData.root)),
      ...(await runRoutineCompaction(workerData.root)),
    ];
    parentPort?.postMessage({
      type: "done",
      results: [
        {
          scenario: `压缩可靠性 / 真实聊天入口与分块保存（${checks.length}项）`,
          status: "脚本化通过",
          requests: {},
          nonFixtureNetworkAttempts: 0,
          window: "未验证",
        },
      ],
    });
  }
} catch (error) {
  if (isMainThread) fail(error);
  else parentPort?.postMessage({ type: "failed", reason: failureReason(error) });
} finally {
  if (!isMainThread) parentPort?.close();
}
