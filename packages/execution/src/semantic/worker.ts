import { parentPort, workerData } from "node:worker_threads";
import { querySemantic } from "./host.ts";
import type { SemanticQuery, SemanticSnapshot } from "./types.ts";

const data = workerData as {
  snapshot: SemanticSnapshot;
  query: SemanticQuery;
  libraries: [string, string][];
  cancel: SharedArrayBuffer;
};
try {
  parentPort?.postMessage({
    ok: true,
    result: querySemantic(data.snapshot, data.query, data.libraries, new Int32Array(data.cancel)),
  });
} catch (error) {
  // Unexpected error messages may contain source text; send only the class name, and the message
  // only when it is one of our own short codes. Packaged post-edit diagnostics failed with nothing
  // more than "Error" (2026-11-04).
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : "";
  parentPort?.postMessage({
    ok: false,
    code: "semantic_failed",
    detail: /^[a-z][a-z0-9_]{2,60}$/.test(message) ? `${name}:${message}` : name,
  });
}
