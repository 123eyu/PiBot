import { createRequire } from "node:module";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { options } from "./options.ts";
import { supervise } from "./supervisor.ts";

try {
  if (isMainThread) {
    if (process.argv.includes("--help")) {
      console.log(
        "node tools/fake-llm/acceptance/memory/index.ts [--timeout 240]\n--real --base-url URL --model ID --input-price USD/M --output-price USD/M [--cache-read-price USD/M] [--api openai-completions] [--header Name:value] [--cap-usd 0.3]\n密钥只读 PIBOT_EVAL_API_KEY；费用按请求保守预留，重试也计入。第6项固定用假模型验证真实会话/32k切换流程。",
      );
    } else
      process.exitCode = await supervise(options(process.argv.slice(2)), process.argv.slice(2));
  } else {
    const desktop = createRequire(
      new URL("../../../../apps/desktop/package.json", import.meta.url),
    );
    const vite = createRequire(desktop.resolve("vite/package.json"));
    const { createJiti } = vite("jiti");
    const loader = createJiti(import.meta.url, { fsCache: false });
    const { main } = await loader.import("./main.ts");
    const code = await main(workerData.root, process.argv.slice(2), (line: string) =>
      parentPort?.postMessage({ type: "line", line }),
    );
    parentPort?.postMessage({ type: "done", code });
    parentPort?.close();
  }
} catch {
  // Arbitrary exceptions can carry provider content; never forward them.
  if (isMainThread) {
    console.error("FAIL memory: 参数、启动或清理失败（详情禁止输出）");
    process.exitCode = 1;
  } else {
    parentPort?.postMessage({ type: "failed" });
    parentPort?.close();
  }
}
