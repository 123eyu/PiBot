// Keep cancellation, publication, and failure cleanup within the same job lifetime.
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { CapabilityContext } from "@pibot/brain/kit";
import type { ImportCounts, ImportPreview, ImportStatus } from "@pibot/import-contract";
import type { ImportStore } from "../store/index.ts";
import type { MemorySelection } from "../store/memories.ts";
import type { PersonaSelection } from "../store/personas.ts";
import { type ImportAdapter, ImportFailure, type ImportInput } from "./adapter.ts";
import type { ImportCleanup } from "./cleanup.ts";
import { distilImport, sampleImport } from "./distillation.ts";
import type { ProjectImport, ProjectReview } from "./project.ts";
import { writeRecords } from "./records.ts";

const JOB_MS = 5 * 60_000;
const PROGRESS_MS = 200;

export function failureReason(error: unknown): NonNullable<ImportStatus["reason"]> {
  if (error instanceof ImportFailure) return error.reason;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" ||
      error.code === "ELOOP" ||
      error.code === "EACCES" ||
      error.code === "EPERM")
  )
    return "source_changed";
  return "internal";
}

type RunOptions = {
  adapter: ImportAdapter;
  input: ImportInput;
  preview: ImportPreview;
  botId: string;
  conversations: boolean;
  memories?: MemorySelection;
  persona?: PersonaSelection;
  project?: { service: ProjectImport; review: ProjectReview };
  distillation?: {
    port: NonNullable<CapabilityContext["local"]["memoryImportDistillation"]>;
    modelId: string;
  };
  store: ImportStore;
  cleanup: ImportCleanup;
  cancel: AbortSignal;
  closing: AbortSignal;
  redactor: CapabilityContext["redactor"];
  logger: CapabilityContext["logger"];
  progress: (status: ImportStatus) => void;
};

function throttledProgress({ preview, progress }: RunOptions) {
  let last = -Infinity;
  return (counts: ImportCounts) => {
    const now = performance.now();
    if (now - last < PROGRESS_MS) return;
    last = now;
    progress({
      importId: preview.importId,
      source: preview.source,
      ...counts,
      state: "running",
      reason: null,
    });
  };
}

export async function runImport(opts: RunOptions) {
  const { preview, botId, store, memories, cancel, closing } = opts;
  const id = preview.importId;
  const deadline = AbortSignal.timeout(JOB_MS);
  const signal = AbortSignal.any([cancel, closing, deadline]);
  const progress = throttledProgress(opts);
  const sample = opts.distillation ? sampleImport() : undefined;
  try {
    await yieldToLoop(undefined, { signal });
    progress({ topics: 0, messages: 0 });
    if (opts.conversations)
      await writeRecords({ ...opts, signal, progress, onMessage: sample?.add });
    const derived =
      sample && opts.distillation
        ? await distilImport(
            opts.distillation.port,
            {
              importId: id,
              botId,
              modelId: opts.distillation.modelId,
              text: sample.text(),
            },
            signal,
            store,
            opts.redactor,
          )
        : undefined;
    signal.throwIfAborted();
    if (!store.availableBot(botId)) throw new ImportFailure("target");
    if (opts.project) {
      try {
        await opts.project.service.apply(id, botId, opts.project.review, signal);
      } catch {
        signal.throwIfAborted();
        throw new ImportFailure("project");
      }
    }
    signal.throwIfAborted();
    if (!store.availableBot(botId)) throw new ImportFailure("target");
    return store.complete(id, () => ({
      memories: [memories, derived].flatMap((selection) => {
        if (!selection?.selected.length) return [];
        const scope = store.memories.add(id, botId, selection);
        return scope ? [scope] : [];
      }),
      persona: opts.persona ? store.personas.apply(id, botId, opts.persona) : false,
    }));
  } catch (error) {
    const state = cancel.aborted || closing.aborted ? "cancelled" : "failed";
    const reason =
      state === "cancelled" ? null : deadline.aborted ? "timeout" : failureReason(error);
    if (reason === "internal") opts.logger.error("import_job_failed");
    store.discard(id, state, reason);
    await opts.cleanup.wake();
    const status = store.get(id);
    if (!status) throw new Error("import_job_missing");
    return { status, change: undefined };
  }
}
