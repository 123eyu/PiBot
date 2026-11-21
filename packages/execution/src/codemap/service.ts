import { dirname, extname } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { codeMapAssets, codeMapLanguageForPath } from "./grammars.ts";
import { MAX_FILE_SYMBOLS } from "./symbols.ts";
import type {
  CodeMapFileResult,
  CodeMapInputFile,
  CodeMapResult,
  CodeMapWorkerFile,
  CodeMapWorkerResponse,
} from "./types.ts";

/** A file larger than this is not worth parsing for a map; the caller can still read it. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 512;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

const SymbolSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.string().min(1).max(40),
  definition: z.boolean(),
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
  depth: z.number().int().nonnegative().optional(),
  declarationRange: z
    .object({
      startLine: z.number().int().positive(),
      startColumn: z.number().int().positive(),
      endLine: z.number().int().positive(),
      endColumn: z.number().int().positive(),
    })
    .optional(),
});
const ResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    result: z.object({
      files: z
        .array(
          z.object({
            path: z.string().max(4096),
            symbols: z.array(SymbolSchema).max(MAX_FILE_SYMBOLS),
          }),
        )
        .max(MAX_FILES),
      reasons: z.array(z.string().max(4200)).max(1024),
    }),
  }),
  z.object({
    ok: z.literal(false),
    code: z.string(),
    detail: z.string().max(120).optional(),
  }),
]);

/** A factory instance owns concurrency and cancellation; it never retains project text. */
export function createCodeMapService(options: { resourcesDir?: string } = {}) {
  const workers = new Set<Worker>();
  const shutdown = new AbortController();
  let active = 0;
  return {
    async extract(files: readonly CodeMapInputFile[], signal: AbortSignal): Promise<CodeMapResult> {
      signal.throwIfAborted();
      if (shutdown.signal.aborted || active >= 2) throw new Error("codemap_busy");
      const bounded = bound(files, codeMapLanguageForPath);
      if (!bounded.work.length)
        return {
          engine: "tree-sitter",
          approximate: true,
          files: bounded.files,
          reasons: bounded.reasons,
        };
      active++;
      let worker: Worker | undefined,
        abort: () => void = () => {};
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const current = AbortSignal.any([signal, shutdown.signal, timeout]);
      try {
        current.throwIfAborted();
        const cancel = new SharedArrayBuffer(4);
        const entry = new URL(
          import.meta.url.endsWith(".ts") ? "./worker.ts" : "./codemap-worker.js",
          import.meta.url,
        );
        worker = new Worker(entry, {
          workerData: {
            files: bounded.work,
            assets: codeMapAssets(options.resourcesDir),
            cancel,
          },
          env: {},
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
        const running = worker;
        workers.add(running);
        const result = await new Promise<CodeMapWorkerResponse>((resolve, reject) => {
          let settled = false;
          /** `detail` says how the worker failed (class name / own code / exit code), never source. */
          const fail = (detail?: string) => {
            if (settled) return;
            settled = true;
            reject(
              Object.assign(
                new Error(
                  signal.aborted || shutdown.signal.aborted
                    ? "codemap_cancelled"
                    : timeout.aborted
                      ? "codemap_timeout"
                      : "codemap_failed",
                ),
                detail ? { detail } : {},
              ),
            );
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
            const parsed = ResponseSchema.safeParse(message);
            if (!parsed.success) {
              fail("bad_message");
              return;
            }
            if (!parsed.data.ok) {
              fail(parsed.data.detail ?? parsed.data.code);
              return;
            }
            settled = true;
            resolve(parsed.data.result as CodeMapWorkerResponse);
          });
          current.addEventListener("abort", abort, { once: true });
          if (current.aborted) abort();
        });
        const symbols = new Map(result.files.map((file) => [file.path, file.symbols]));
        return {
          engine: "tree-sitter",
          approximate: true,
          // `hash` and `symbols` only come back together, so a caller can treat a hash as proof
          // that this version was parsed instead of keeping an unparsed file stale forever.
          files: bounded.files.map((file) => {
            const parsed = symbols.get(file.path);
            return parsed
              ? { ...file, symbols: parsed }
              : { path: file.path, language: file.language };
          }),
          reasons: [...bounded.reasons, ...result.reasons],
        };
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

/**
 * File, byte and language limits are decided here because only the caller knows which files it
 * was authorized to read; over-limit files stay in the result (without a hash) so an index can
 * still record that they were skipped and why, without treating them as parsed.
 */
function bound(files: readonly CodeMapInputFile[], languageFor: typeof codeMapLanguageForPath) {
  const results: CodeMapFileResult[] = [];
  const work: CodeMapWorkerFile[] = [];
  const reasons: string[] = [];
  let bytes = 0;
  const cppDirectories = new Set(
    files
      .filter((file) => extname(file.path).toLowerCase() === ".cpp")
      .map((file) => dirname(file.path)),
  );
  for (const file of files) {
    // Only files that reach the parser take a slot: a skipped file costs no worker time.
    if (work.length >= MAX_FILES) {
      reasons.push("file_limit");
      break;
    }
    const language = languageFor(file.path, {
      text: file.text,
      hasCppSibling: file.hasCppSibling || cppDirectories.has(dirname(file.path)),
    });
    if (!language) {
      reasons.push(`unsupported_language:${file.path}`);
      results.push({ path: file.path, language: null });
      continue;
    }
    const size = Buffer.byteLength(file.text, "utf8");
    if (size > MAX_FILE_BYTES) {
      reasons.push(`file_too_large:${file.path}`);
      results.push({ path: file.path, language });
      continue;
    }
    if (bytes + size > MAX_BATCH_BYTES) {
      reasons.push("byte_limit");
      break;
    }
    bytes += size;
    work.push({ path: file.path, language, text: file.text });
    results.push({ path: file.path, language });
  }
  return { files: results, work, reasons };
}
