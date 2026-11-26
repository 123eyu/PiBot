// A single job owner keeps preview authorizations, progress, and cancellation consistent.
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { CapabilityContext } from "@pibot/brain/kit";
import type {
  ImportCounts,
  ImportPreview,
  ImportSource,
  ImportStatus,
} from "@pibot/import-contract";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import type { ImportStore } from "../store/index.ts";
import { adapters, ImportFailure, type ImportInput } from "./adapter.ts";
import { ImportCleanup } from "./cleanup.ts";
import { exportAdapter } from "./exports/index.ts";
import { fixtureAdapter } from "./fixture.ts";
import { summarize, writeRecords } from "./records.ts";
import { selectedInput } from "./source.ts";

const JOB_MS = 5 * 60_000;
const PREVIEW_MS = 90_000;
const PREVIEW_VALID_MS = 10 * 60_000;
const PROGRESS_MS = 200;

type Selection = { preview: ImportPreview; input: ImportInput; expiresAt: number };
type Running = { importId: string; controller: AbortController; done: Promise<ImportStatus> };

function failureReason(error: unknown): NonNullable<ImportStatus["reason"]> {
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

export class ImportJobs {
  private readonly adapters = adapters(
    fixtureAdapter,
    exportAdapter("chatgpt"),
    exportAdapter("claude"),
  );
  private readonly closing = new AbortController();
  private readonly cleanup: ImportCleanup;
  private selection?: Selection;
  private previewing?: Promise<ImportPreview | null>;
  private active?: Running;

  constructor(
    private readonly ctx: CapabilityContext,
    private readonly store: ImportStore,
  ) {
    this.cleanup = new ImportCleanup(
      store,
      this.closing.signal,
      (status) => this.publish(status),
      () => this.ctx.logger.error("import_cleanup_failed"),
    );
  }

  idle() {
    return !this.active && !this.previewing && this.cleanup.idle();
  }

  recover() {
    this.store.recover();
    void this.cleanup.wake();
  }

  async detect(source: ImportSource, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.closing.signal, AbortSignal.timeout(PREVIEW_MS)]);
    for await (const available of this.adapters[source].detect(signal)) {
      signal.throwIfAborted();
      return { available: available && !!this.ctx.host.pickFile };
    }
    return { available: false };
  }

  async preview(source: ImportSource, caller: AbortSignal) {
    this.closing.signal.throwIfAborted();
    if (this.previewing) throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_busy");
    const work = this.openPreview(source, caller);
    this.previewing = work;
    try {
      return await work;
    } finally {
      this.previewing = undefined;
    }
  }

  private async openPreview(source: ImportSource, caller: AbortSignal) {
    this.selection = undefined;
    const deadline = AbortSignal.timeout(PREVIEW_MS);
    const signal = AbortSignal.any([caller, this.closing.signal, deadline]);
    try {
      if (!(await this.detect(source, signal)).available)
        throw new RpcError(RpcErrorCodes.unsupported, "import_source_unsupported");
      const path = await this.ctx.host.pickFile?.(signal);
      signal.throwIfAborted();
      if (!path) return null;
      const input = await selectedInput(this.ctx.local.deps, path, signal);
      const summary = await summarize(this.adapters[source], input, signal);
      const preview = { importId: randomUUID(), source, ...summary };
      signal.throwIfAborted();
      this.selection = { preview, input, expiresAt: Date.now() + PREVIEW_VALID_MS };
      return preview;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (deadline.aborted)
        throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_timeout");
      signal.throwIfAborted();
      const reason = failureReason(error);
      if (reason === "internal") throw error;
      if (reason === "format" && (source === "chatgpt" || source === "claude"))
        throw new RpcError(RpcErrorCodes.invalidParams, `import_format_${source}`);
      throw new RpcError(RpcErrorCodes.invalidParams, `import_${reason}`);
    }
  }

  start(importId: string, botId: string) {
    this.closing.signal.throwIfAborted();
    const existing = this.store.get(importId);
    if (existing) {
      if (this.store.target(importId) !== botId)
        throw new RpcError(RpcErrorCodes.invalidParams, "import_target");
      return existing;
    }
    if (this.active || this.store.unfinished())
      throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
    if (!this.store.availableBot(botId))
      throw new RpcError(RpcErrorCodes.invalidParams, "import_target");
    const selection = this.selection;
    if (!selection || selection.preview.importId !== importId || Date.now() > selection.expiresAt)
      throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_expired");
    this.store.create(importId, selection.preview.source, botId);
    this.selection = undefined;
    const controller = new AbortController();
    const done = this.run(selection, botId, controller.signal).finally(() => {
      this.active = undefined;
    });
    this.active = { importId, controller, done };
    // A later status/cancel call still receives the persisted result or the original failure.
    void done.catch(() => this.ctx.logger.error("import_cleanup_failed"));
    return this.status(importId);
  }

  status(importId: string) {
    const status = this.store.get(importId);
    if (!status) throw new RpcError(RpcErrorCodes.invalidParams, "import_unknown");
    return status;
  }

  async cancel(importId: string) {
    const status = this.status(importId);
    if (status.state !== "running" || this.active?.importId !== importId) return status;
    this.active.controller.abort();
    return this.active.done;
  }

  undo(importId: string) {
    this.closing.signal.throwIfAborted();
    const status = this.status(importId);
    if (status.state === "undone") return status;
    if (status.state === "undoing") {
      void this.cleanup.wake();
      return status;
    }
    if (status.state !== "completed")
      throw new RpcError(RpcErrorCodes.invalidParams, "import_not_completed");
    const pending = this.store.beginUndo(importId);
    this.changedTopics(importId);
    this.publish(pending);
    void this.cleanup.wake();
    return pending;
  }

  async stop() {
    this.closing.abort();
    this.selection = undefined;
    // A picker rejection after shutdown is expected; the RPC caller owns that error.
    await this.previewing?.catch(() => undefined);
    await Promise.all([this.active?.done, this.cleanup.wait()]);
  }

  private async run(selection: Selection, botId: string, cancel: AbortSignal) {
    const deadline = AbortSignal.timeout(JOB_MS);
    const signal = AbortSignal.any([cancel, this.closing.signal, deadline]);
    const { preview, input } = selection;
    let state: "completed" | "cancelled" | "failed" = "completed";
    let reason: ImportStatus["reason"] = null;
    let last = -Infinity;
    const progress = (counts: ImportCounts) => {
      const now = performance.now();
      if (now - last < PROGRESS_MS) return;
      last = now;
      this.publish({
        importId: preview.importId,
        source: preview.source,
        ...counts,
        state: "running",
        reason: null,
      });
    };
    try {
      await yieldToLoop(undefined, { signal });
      progress({ topics: 0, messages: 0 });
      await writeRecords({
        adapter: this.adapters[preview.source],
        input,
        preview,
        botId,
        store: this.store,
        redactor: this.ctx.redactor,
        signal,
        progress,
      });
      signal.throwIfAborted();
      if (!this.store.availableBot(botId)) throw new ImportFailure("target");
    } catch (error) {
      state = cancel.aborted || this.closing.signal.aborted ? "cancelled" : "failed";
      reason = state === "cancelled" ? null : deadline.aborted ? "timeout" : failureReason(error);
      if (reason === "internal") this.ctx.logger.error("import_job_failed");
    }
    const id = preview.importId;
    if (state !== "completed") {
      this.store.discard(id, state, reason);
      await this.cleanup.wake();
      return this.status(id);
    }
    const result = this.store.complete(id);
    this.changedTopics(id);
    return this.publish(result);
  }

  private changedTopics(importId: string) {
    const botId = this.store.target(importId);
    if (typeof botId !== "string") return;
    try {
      this.ctx.peer.emit("sidebar.changed", { conversationKey: `dm:${botId}` });
    } catch {
      // The committed state is authoritative even if the peer disconnected.
      this.ctx.logger.warn("import_topics_not_delivered");
    }
  }

  private publish(status: ImportStatus) {
    try {
      this.ctx.peer.emit("import.progress", status);
    } catch {
      // The caller can recover authoritative status after a disconnect or delivery failure.
      this.ctx.logger.warn("import_progress_not_delivered");
    }
    return status;
  }
}
