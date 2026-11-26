// Own the short-lived user approvals bound to one source and import identity.
import { randomUUID } from "node:crypto";
import type { CapabilityContext } from "@pibot/brain/kit";
import type { ImportMemoryReview, ImportPreview } from "@pibot/import-contract";
import type { ImportParams } from "@pibot/import-contract/full";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import type { ImportStore } from "../store/index.ts";
import type { ImportInput } from "./adapter.ts";
import { type ReviewedImport, reviewMemories } from "./memory-review.ts";
import type { ProjectImport, ProjectReview } from "./project.ts";
import { failureReason } from "./run.ts";

const PREVIEW_MS = 90_000;
const PREVIEW_VALID_MS = 10 * 60_000;

type Selection = {
  preview: ImportPreview;
  input: ImportInput;
  expiresAt: number;
  review?: ReviewedImport;
  persona?: ReviewedImport;
  project?: ProjectReview;
  quote?: { quoteId: string; botId: string; modelId: string };
};
export class ImportReviews {
  private selection?: Selection;
  private reviewing?: Promise<unknown>;

  constructor(
    private readonly ctx: CapabilityContext,
    private readonly store: ImportStore,
    private readonly project: ProjectImport,
    private readonly signal: AbortSignal,
    private readonly previewing: () => boolean,
  ) {}

  busy() {
    return !!this.reviewing;
  }

  set(preview: ImportPreview, input: ImportInput) {
    this.selection = { preview, input, expiresAt: Date.now() + PREVIEW_VALID_MS };
  }

  clear() {
    this.selection = undefined;
  }

  async wait() {
    // The RPC owns and reports an aborted review.
    await this.reviewing?.catch(() => undefined);
  }

  async review(
    { importId, botId, scope }: ImportParams<"import.reviewMemories">,
    caller: AbortSignal,
  ): Promise<ImportMemoryReview> {
    this.signal.throwIfAborted();
    if (this.reviewing || this.previewing())
      throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_busy");
    if (!this.store.availableBot(botId))
      throw new RpcError(RpcErrorCodes.invalidParams, "import_target");
    const selection = this.requireSelection(importId);
    const slot = scope === "persona" ? "persona" : "review";
    selection[slot] = undefined;
    const deadline = AbortSignal.timeout(PREVIEW_MS);
    const signal = AbortSignal.any([caller, this.signal, deadline]);
    const work = reviewMemories({
      ...selection,
      botId,
      scope,
      signal,
      memories: this.store.memories,
      personas: this.store.personas,
      redactor: this.ctx.redactor,
    });
    this.reviewing = work;
    try {
      const review = await work;
      signal.throwIfAborted();
      this.requireSelection(importId)[slot] = review;
      return review.dto;
    } catch (error) {
      if (deadline.aborted)
        throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_timeout");
      signal.throwIfAborted();
      const reason = failureReason(error);
      if (reason === "internal") throw error;
      throw new RpcError(RpcErrorCodes.invalidParams, `import_${reason}`);
    } finally {
      this.reviewing = undefined;
    }
  }

  requireSelection(importId: string) {
    const selection = this.selection;
    if (!selection || selection.preview.importId !== importId || Date.now() > selection.expiresAt)
      throw new RpcError(RpcErrorCodes.invalidParams, "import_preview_expired");
    return selection;
  }

  estimateDistillation({ importId, botId }: ImportParams<"import.estimateDistillation">) {
    const selection = this.requireSelection(importId);
    const estimate = this.ctx.local.memoryImportDistillation?.estimate(botId);
    selection.quote = undefined;
    if (!estimate || !selection.preview.messages) return null;
    const quoteId = randomUUID();
    selection.quote = { quoteId, botId, modelId: estimate.modelId };
    return { quoteId, ...estimate };
  }

  async reviewProject(importId: string, caller: AbortSignal) {
    this.signal.throwIfAborted();
    if (this.reviewing || this.previewing()) throw new RpcError(-32602, "import_preview_busy");
    const selection = this.requireSelection(importId);
    selection.project = undefined;
    const signal = AbortSignal.any([caller, this.signal, AbortSignal.timeout(PREVIEW_MS)]);
    const work = this.project.review(selection.preview, selection.input, signal);
    this.reviewing = work;
    try {
      const review = await work;
      signal.throwIfAborted();
      if (!review) return null;
      this.requireSelection(importId).project = review;
      return {
        reviewId: review.reviewId,
        file: "AGENTS.md" as const,
        folder: review.folder,
        diff: review.diff,
      };
    } catch (error) {
      caller.throwIfAborted();
      this.signal.throwIfAborted();
      if (error instanceof RpcError) throw error;
      throw new RpcError(-32602, "import_project_unavailable");
    } finally {
      this.reviewing = undefined;
    }
  }
}
