// Worker entry for htmlTextInWorker: parses one page off the caller's thread and posts the result.
import { parentPort, workerData } from "node:worker_threads";
import { htmlText } from "./html-text.ts";

const input = workerData as { html: string; maxElements?: number };
htmlText(input.html, { maxElements: input.maxElements }).then(
  (result) => parentPort?.postMessage({ ok: true, title: result.title, text: result.text }),
  () => parentPort?.postMessage({ ok: false }),
);
