import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { SemanticError, type SemanticFailure } from "./errors.ts";
import { STANDARD_LIBRARIES } from "./libraries.ts";
import type { SemanticQuery, SemanticSnapshot } from "./types.ts";

/**
 * Packaged apps carry the libraries beside the bundle (electron-builder drops `*.d.ts` from
 * node_modules: every packaged query failed with ENOENT until 2026-11-04); source runs and other
 * hosts read them from the typescript-runtime package. Hashes are checked either way.
 */
async function libraryRoot(signal: AbortSignal): Promise<{ root: string; suffix: string }> {
  if (!import.meta.url.endsWith(".ts")) {
    // Copied with a `.txt` suffix: electron-builder drops every `*.d.ts` from the package.
    const bundled = fileURLToPath(new URL("./typescript-lib/", import.meta.url));
    try {
      await access(join(bundled, "lib.d.ts.txt"));
      signal.throwIfAborted();
      return { root: bundled, suffix: ".txt" };
    } catch (error) {
      signal.throwIfAborted();
      // Not a desktop bundle (CLI, server): fall back to the package.
      if ((error as { code?: unknown } | null)?.code !== "ENOENT") throw error;
    }
  }
  return {
    root: join(
      dirname(createRequire(import.meta.url).resolve("typescript-runtime/package.json")),
      "lib",
    ),
    suffix: "",
  };
}

async function trustedLibraries(signal: AbortSignal): Promise<[string, string][]> {
  const { root, suffix } = await libraryRoot(signal);
  const result: [string, string][] = [];
  let bytes = 0;
  for (const [name, sha256] of Object.entries(STANDARD_LIBRARIES)) {
    const data = await readFile(join(root, `${name}${suffix}`), { signal });
    if (createHash("sha256").update(data).digest("hex") !== sha256)
      throw new SemanticError("unavailable", "semantic_library_changed");
    const text = data.toString("utf8");
    bytes += data.byteLength;
    if (bytes > 16 * 1024 * 1024) throw new SemanticError("too_large", "semantic_library_limit");
    result.push([name, text]);
  }
  return result;
}

/**
 * The worker reports its own short codes and class names; everything else is an engine error. A
 * fixed code is what makes one log line say whether retrying or narrowing would help.
 */
function failureCode(detail: string | undefined): SemanticFailure {
  if (!detail) return "worker_error";
  if (detail.startsWith("worker_exit")) return "worker_exit";
  if (detail.startsWith("worker_error") || detail === "bad_message") return "worker_error";
  if (/semantic_(?:position_invalid|file_unavailable|config_unavailable)/.test(detail))
    return "invalid_input";
  if (detail.includes("semantic_library_changed")) return "unavailable";
  return "worker_error";
}

/** A factory instance owns concurrency and cancellation; it never retains project text. */
export function createSemanticService() {
  const workers = new Set<Worker>(),
    shutdown = new AbortController();
  let active = 0;
  return {
    async query(
      snapshot: SemanticSnapshot,
      query: SemanticQuery,
      signal: AbortSignal,
    ): Promise<unknown> {
      signal.throwIfAborted();
      if (shutdown.signal.aborted || active >= 2) throw new SemanticError("busy", "semantic_busy");
      active++;
      let worker: Worker | undefined,
        abort: () => void = () => {};
      const current = AbortSignal.any([signal, shutdown.signal, AbortSignal.timeout(15_000)]);
      try {
        const libraries = await trustedLibraries(current);
        current.throwIfAborted();
        const cancel = new SharedArrayBuffer(4);
        const entry = new URL(
          import.meta.url.endsWith(".ts") ? "./worker.ts" : "./semantic-worker.js",
          import.meta.url,
        );
        worker = new Worker(entry, {
          workerData: { snapshot, query, libraries, cancel },
          env: {},
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
        const running = worker;
        workers.add(running);
        return await new Promise((resolve, reject) => {
          let settled = false;
          /** `detail` says how the worker failed (class name / own code / exit code), never source. */
          const fail = (detail?: string) => {
            if (!settled) {
              settled = true;
              // A caller stop and this query's own 15 s deadline used to look identical here.
              const code: SemanticFailure =
                signal.aborted || shutdown.signal.aborted
                  ? "cancelled"
                  : current.aborted
                    ? "timeout"
                    : failureCode(detail);
              reject(
                new SemanticError(
                  code,
                  current.aborted ? "semantic_cancelled" : "semantic_failed",
                  detail,
                ),
              );
            }
          };
          abort = () => {
            Atomics.store(new Int32Array(cancel), 0, 1);
            fail();
            void running.terminate();
          };
          running.once("error", (error: Error & { code?: unknown }) =>
            fail(`worker_error:${typeof error.code === "string" ? error.code : error.name}`),
          );
          running.once("exit", (code) => {
            // No message before exit: crashed or killed (resource limit).
            if (!settled) fail(`worker_exit:${code}`);
          });
          running.once("message", (message: unknown) => {
            if (settled) return;
            const parsed = z
              .discriminatedUnion("ok", [
                z.object({ ok: z.literal(true), result: z.unknown() }),
                z.object({
                  ok: z.literal(false),
                  code: z.string(),
                  detail: z.string().max(120).optional(),
                }),
              ])
              .safeParse(message);
            if (!parsed.success) {
              fail("bad_message");
              return;
            }
            if (!parsed.data.ok) {
              fail(parsed.data.detail ?? parsed.data.code);
              return;
            }
            settled = true;
            resolve(parsed.data.result);
          });
          current.addEventListener("abort", abort, { once: true });
          if (current.aborted) abort();
        });
      } finally {
        current.removeEventListener("abort", abort);
        if (worker) {
          await worker.terminate();
          workers.delete(worker);
        }
        active--;
      }
    },
    async dispose() {
      shutdown.abort();
      await Promise.all([...workers].map((worker) => worker.terminate()));
      workers.clear();
    },
  };
}
