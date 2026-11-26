// A single job owner keeps preview authorizations, progress, and cancellation consistent.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CapabilityContext } from "@pibot/brain/kit";
import type { ImportPreview, ImportSource, ImportStatus } from "@pibot/import-contract";
import type { ImportParams } from "@pibot/import-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import type { ImportStore } from "../store/index.ts";
import type { ImportMemoryScope } from "../store/memories.ts";
import { adapters } from "./adapter.ts";
import { ImportCleanup } from "./cleanup.ts";
import { exportAdapter } from "./exports/index.ts";
import { fixtureAdapter } from "./fixture.ts";
import { configRootFor, isLocalSource, supportsLocalSources } from "./local/locations.ts";
import { readProjectNote } from "./local/text.ts";
import { selectReview } from "./memory-review.ts";
import { ProjectImport } from "./project.ts";
import { summarize } from "./records.ts";
import { ImportReviews } from "./reviews.ts";
import { failureReason, runImport } from "./run.ts";
import { selectedInput } from "./source.ts";

const PREVIEW_MS = 90_000;

type Running = { importId: string; controller: AbortController; done: Promise<ImportStatus> };

export class ImportJobs {
  private readonly adapters = adapters(
    fixtureAdapter,
    exportAdapter("chatgpt"),
    exportAdapter("claude"),
  );
  private readonly closing = new AbortController();
  private readonly cleanup: ImportCleanup;
  private readonly project: ProjectImport;
  private previewing?: Promise<ImportPreview | null>;
  readonly reviews: ImportReviews;
  private active?: Running;
  private undoReservation?: Promise<void>;

  constructor(
    private readonly ctx: CapabilityContext,
    private readonly store: ImportStore,
  ) {
    this.project = new ProjectImport(ctx, store.projects);
    this.reviews = new ImportReviews(
      ctx,
      store,
      this.project,
      this.closing.signal,
      () => !!this.previewing,
    );
    this.cleanup = new ImportCleanup(
      store,
      this.closing.signal,
      (status) => this.publish(status),
      () => this.ctx.logger.error("import_cleanup_failed"),
      (id, signal) => {
        const botId = this.store.target(id);
        if (typeof botId !== "string") throw new Error("import_job_missing");
        return this.project.restore(id, botId, signal);
      },
    );
  }

  idle() {
    return (
      !this.active &&
      !this.undoReservation &&
      !this.previewing &&
      !this.reviews.busy() &&
      this.cleanup.idle()
    );
  }

  recover() {
    this.store.recover();
    void this.cleanup.wake();
  }

  async detect(source: ImportSource, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.closing.signal, AbortSignal.timeout(PREVIEW_MS)]);
    if (isLocalSource(source) && !supportsLocalSources(this.ctx.local.deps.platform))
      return { available: false };
    for await (const available of this.adapters[source].detect(signal)) {
      signal.throwIfAborted();
      return { available: available && !!this.ctx.host.pickFile };
    }
    return { available: false };
  }

  async preview(source: ImportSource, caller: AbortSignal) {
    this.closing.signal.throwIfAborted();
    if (this.previewing || this.reviews.busy())
      throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_busy");
    const work = this.openPreview(source, caller);
    this.previewing = work;
    try {
      return await work;
    } finally {
      this.previewing = undefined;
    }
  }

  private async openPreview(source: ImportSource, caller: AbortSignal) {
    this.reviews.clear();
    const deadline = AbortSignal.timeout(PREVIEW_MS);
    const signal = AbortSignal.any([caller, this.closing.signal, deadline]);
    try {
      if (!(await this.detect(source, signal)).available)
        throw new RpcError(RpcErrorCodes.unsupported, "import_source_unsupported");
      const path = await this.ctx.host.pickFile?.(signal, this.pickerOptions(source));
      signal.throwIfAborted();
      if (!path) return null;
      const input = await selectedInput(this.ctx.local.deps, path, signal, source);
      const summary = input.projectNote
        ? await readProjectNote(input, signal).then(() => ({
            topics: 0,
            messages: 0,
            from: null,
            through: null,
            projectNotes: 1,
          }))
        : await summarize(this.adapters[source], input, signal);
      const preview = { importId: randomUUID(), source, ...summary };
      signal.throwIfAborted();
      this.reviews.set(preview, input);
      return preview;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (deadline.aborted)
        throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_timeout");
      signal.throwIfAborted();
      const reason = failureReason(error);
      if (reason === "internal") throw error;
      if (reason === "unsupported")
        throw new RpcError(RpcErrorCodes.unsupported, "import_source_unsupported");
      if (reason === "format" && source !== "fixture")
        throw new RpcError(
          RpcErrorCodes.invalidParams,
          `import_format_${source.replace("-", "_")}`,
        );
      throw new RpcError(RpcErrorCodes.invalidParams, `import_${reason}`);
    }
  }

  private pickerOptions(source: ImportSource) {
    const { platform, userHome } = this.ctx.local.deps;
    if (!isLocalSource(source) || !supportsLocalSources(platform)) return undefined;
    const subdirectory = source === "codex" ? "sessions" : "projects";
    return { defaultPath: join(configRootFor(source, platform, userHome), subdirectory) };
  }

  start(
    importId: string,
    botId: string,
    {
      conversations = true,
      memoryReview,
      personaReview,
      distillationQuoteId,
      projectReviewId,
    }: Omit<ImportParams<"import.start">, "importId" | "botId"> = {},
  ) {
    this.closing.signal.throwIfAborted();
    const existing = this.store.get(importId);
    if (existing) {
      if (this.store.target(importId) !== botId)
        throw new RpcError(RpcErrorCodes.invalidParams, "import_target");
      return existing;
    }
    if (this.active || this.undoReservation || this.reviews.busy() || this.store.unfinished())
      throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
    if (!this.store.availableBot(botId))
      throw new RpcError(RpcErrorCodes.invalidParams, "import_target");
    const selection = this.reviews.requireSelection(importId);
    const mapping = {
      ...(memoryReview ? selectReview(selection.review, botId, memoryReview) : {}),
      ...(personaReview ? selectReview(selection.persona, botId, personaReview) : {}),
    };
    const quote = selection.quote;
    const port = this.ctx.local.memoryImportDistillation;
    if (
      distillationQuoteId &&
      (!conversations ||
        !port ||
        quote?.quoteId !== distillationQuoteId ||
        quote.botId !== botId ||
        port.estimate(botId)?.modelId !== quote.modelId)
    )
      throw new RpcError(-32602, "import_distillation_quote_expired");
    const distillation =
      distillationQuoteId && quote && port ? { port, modelId: quote.modelId } : undefined;
    const reviewedProject = selection.project;
    if (projectReviewId && reviewedProject?.reviewId !== projectReviewId)
      throw new RpcError(-32602, "import_project_review_expired");
    const project =
      projectReviewId && reviewedProject
        ? { service: this.project, review: reviewedProject }
        : undefined;
    if (!conversations && !mapping.memories?.selected.length && !mapping.persona && !project)
      throw new RpcError(RpcErrorCodes.invalidParams, "import_memory_selection_invalid");
    if (selection.input.projectNote && (conversations || !project))
      throw new RpcError(RpcErrorCodes.invalidParams, "import_project_review_expired");
    if (selection.preview.source === "gemini" && selection.preview.topics === 0)
      throw new RpcError(RpcErrorCodes.invalidParams, "import_format_gemini");
    if (project && this.store.projects.compensating(project.review.receipt.root))
      throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
    this.store.create(importId, selection.preview.source, botId);
    this.reviews.clear();
    const controller = new AbortController();
    const done = runImport({
      preview: selection.preview,
      input: selection.input,
      botId,
      conversations,
      cancel: controller.signal,
      closing: this.closing.signal,
      adapter: this.adapters[selection.preview.source],
      redactor: this.ctx.redactor,
      logger: this.ctx.logger,
      cleanup: this.cleanup,
      store: this.store,
      ...mapping,
      distillation,
      project,
      progress: (status) => this.publish(status),
    })
      .then(({ status, change }) => {
        if (status.state === "completed") {
          this.changedTopics(importId);
          for (const scope of new Set(change?.memories))
            this.changedMemories(importId, scope, "added");
          if (change?.persona) this.changedPersona(botId);
          this.publish(status);
        }
        return status;
      })
      .finally(() => {
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

  async undo(importId: string) {
    this.closing.signal.throwIfAborted();
    if (this.undoReservation) throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
    let release = () => {};
    this.undoReservation = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const status = this.status(importId);
      if (status.state === "undone") return status;
      if (status.state === "undoing" || this.store.cleaning(importId)) {
        void this.cleanup.wake(importId);
        return status;
      }
      if (this.active) throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
      if (status.state !== "completed")
        throw new RpcError(RpcErrorCodes.invalidParams, "import_not_completed");
      await this.project.assertUndoable(
        importId,
        AbortSignal.any([this.closing.signal, AbortSignal.timeout(PREVIEW_MS)]),
      );
      this.closing.signal.throwIfAborted();
      // No yield between these checks and the transaction; start and other undos hold the same reservation.
      if (this.active || this.store.unfinished() || this.status(importId).state !== "completed")
        throw new RpcError(RpcErrorCodes.invalidParams, "import_busy");
      const { status: pending, change, persona } = this.store.beginUndo(importId);
      this.changedTopics(importId);
      for (const scope of change) this.changedMemories(importId, scope, "removed");
      const botId = this.store.target(importId);
      if (persona && typeof botId === "string") this.changedPersona(botId);
      this.publish(pending);
      void this.cleanup.wake(importId);
      return pending;
    } finally {
      this.undoReservation = undefined;
      release();
    }
  }

  async stop() {
    this.closing.abort();
    this.reviews.clear();
    // A picker rejection after shutdown is expected; the RPC caller owns that error.
    await this.previewing?.catch(() => undefined);
    await this.reviews.wait();
    await Promise.all([this.active?.done, this.undoReservation, this.cleanup.wait()]);
  }

  private changedMemories(
    importId: string,
    scope: ImportMemoryScope | undefined,
    reason: "added" | "removed",
  ) {
    const botId = this.store.target(importId);
    if (!scope || typeof botId !== "string") return;
    try {
      this.ctx.peer.emit("memory.changed", {
        botId,
        scope,
        ownerId: scope === "user" ? "user" : botId,
        reason,
      });
    } catch {
      // Memory was already committed; readers can refresh from storage after reconnecting.
      this.ctx.logger.warn("import_memory_event_not_delivered");
    }
  }
  private changedPersona(botId: string) {
    try {
      this.ctx.peer.emit("bots.changed", { botId, reason: "updated" });
    } catch {
      // The stored persona is authoritative after a disconnect.
      this.ctx.logger.warn("import_persona_event_not_delivered");
    }
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
