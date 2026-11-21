import { parentPort, workerData } from "node:worker_threads";
import { extractCodeMap } from "./extract.ts";
import type { CodeMapWorkerRequest } from "./types.ts";

const data = workerData as CodeMapWorkerRequest;
const cancel = new Int32Array(data.cancel);
try {
  const result = await extractCodeMap(data.files, data.assets, () => Atomics.load(cancel, 0) === 1);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  // Unexpected error messages may repeat source text; send only the class name, and the message
  // only when it is one of our own short codes.
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : "";
  parentPort?.postMessage({
    ok: false,
    code: "codemap_failed",
    detail: /^[a-z][a-z0-9_]{2,60}$/.test(message) ? `${name}:${message}` : name,
  });
}
