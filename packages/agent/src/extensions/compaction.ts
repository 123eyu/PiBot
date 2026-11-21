import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentError, agentHttpStatus, mapAgentError } from "../core/errors.ts";
import type { AgentErrorCode, CompactionActivity } from "../core/types.ts";
import { contextBudget } from "../runtime/context-budget.ts";
import type { RequestAccounting } from "../runtime/request-observer.ts";
import { checkpointBoundary, makeCheckpointPlan, planStillApplies } from "./checkpoint-plan.ts";
import { redactCheckpoint } from "./checkpoint-result.ts";
import { summarizeCheckpoint } from "./checkpoint-summary.ts";

export { summaryTranscript } from "./checkpoint-transcript.ts";

export interface CompactionState {
  backgroundTask?: boolean;
  summaryModel?(signal: AbortSignal): Promise<import("./checkpoint-request.ts").SummaryModel>;
  contextWindow?: number;
  timing?: { idleMs?: number; retryMs?: number; totalMs?: number };
  selfRetainingBoundary?(): string;
  cache?: import("./checkpoint-result.ts").CheckpointCache;
  identity?(): string;
  unattended?: boolean;
  progress?(result: import("./checkpoint-result.ts").CheckpointResult): Promise<void>;
  scopeVersion?(): string;
  toolSet?(): import("../core/types.ts").ToolSetSnapshot;
  /** Run-registration identities for metrics, independent of the summary's empty tool catalog. */
  metricToolNames?: ReadonlySet<string>;
  estimateScale?: number;
  /**
   * A checkpoint pass could not lower the estimate, so the request copy also collapses the
   * oversized tool results of the tail pi keeps verbatim (see `tool-result-trim.ts`). Set once per
   * session by the pre-prompt loop; the collapsed copy is the same for every later request.
   */
  collapseRecent?: boolean;
  estimateHistory?(
    messages: import("@earendil-works/pi-coding-agent").ContextEvent["messages"],
  ): number;
  background?: {
    drain(): Promise<void>;
    cancel(): void;
    take?(branch: import("@earendil-works/pi-coding-agent").SessionEntry[]): Promise<
      | {
          plan: import("./checkpoint-plan.ts").CheckpointPlan;
          result: import("./checkpoint-result.ts").CheckpointResult;
        }
      | undefined
    >;
  };
  accounting?: RequestAccounting;
  overflowRecoveryAttempted?: boolean;
  failure?: AgentErrorCode;
  diagnostic?: Omit<NonNullable<CompactionActivity["failure"]>, "code"> & {
    code?: AgentErrorCode;
  };
  pending?: { reason: CompactionActivity["reason"]; entryCount: number; started: number };
  signal?: AbortSignal;
  operationSignal?: AbortSignal;
  redact(text: string): string;
  activity?(event: CompactionActivity): void;
}

/** One allowance per run, shared by preflight and pi's provider-overflow continuation. */
export function claimOverflowRecovery(state: CompactionState): boolean {
  state.signal?.throwIfAborted();
  state.operationSignal?.throwIfAborted();
  if (state.overflowRecoveryAttempted) return false;
  state.overflowRecoveryAttempted = true;
  return true;
}

export function finishCompaction(state: CompactionState, outcome: CompactionActivity["outcome"]) {
  const pending = state.pending;
  if (!pending) return;
  state.pending = undefined;
  state.activity?.({
    phase: "end",
    reason: pending.reason,
    entryCount: pending.entryCount,
    durationMs: Math.max(0, Date.now() - pending.started),
    outcome,
    ...(outcome !== "done" && state.failure
      ? {
          failure: {
            stage: "transcript" as const,
            ...state.diagnostic,
            code: state.diagnostic?.code ?? state.failure,
          },
        }
      : {}),
  });
}

export function registerCompaction(pi: ExtensionAPI, state?: CompactionState) {
  if (!state) return;
  pi.on("session_before_compact", async (event, ctx) => {
    if (
      event.reason === "threshold" &&
      !Number.isFinite(contextBudget(ctx.model?.contextWindow).triggerTokens)
    )
      return { cancel: true };
    // pi can check the same threshold again after our cancellation. The original failure
    // already owns the status and provider receipt; do not report another zero-duration attempt.
    if (state.failure) return { cancel: true };
    if (
      event.reason === "overflow" &&
      event.willRetry &&
      state.accounting?.responseError?.code === "context_overflow" &&
      !state.signal?.aborted &&
      !state.operationSignal?.aborted &&
      !event.signal.aborted &&
      !claimOverflowRecovery(state)
    ) {
      state.failure = "context_overflow";
      return { cancel: true };
    }
    state.diagnostic = { stage: "transcript" };
    state.pending = {
      reason: event.reason,
      entryCount:
        event.preparation.messagesToSummarize.length + event.preparation.turnPrefixMessages.length,
      started: Date.now(),
    };
    try {
      state.activity?.({
        phase: "start",
        reason: event.reason,
        entryCount: state.pending.entryCount,
      });
      if (!ctx.model) throw new AgentError("compaction_failed");
      const branch = ctx.sessionManager.getBranch();
      const candidate = await state.background?.take?.(branch);
      const plan =
        candidate?.plan ?? makeCheckpointPlan(branch, ctx.model.contextWindow, state.redact);
      if (!plan) throw new AgentError("compaction_failed");
      const result = redactCheckpoint(
        candidate?.result ??
          (await summarizeCheckpoint(plan, ctx.modelRegistry, ctx.model, state, event.signal)),
        state.redact,
      );
      event.signal.throwIfAborted();
      state.signal?.throwIfAborted();
      state.operationSignal?.throwIfAborted();
      if (!planStillApplies(plan, ctx.sessionManager.getBranch()))
        throw new AgentError("context_unavailable");
      const boundary =
        checkpointBoundary(plan, result.consumedMessages, ctx.sessionManager.getBranch()) ??
        state.selfRetainingBoundary?.();
      if (!boundary) throw new AgentError("compaction_failed");
      return {
        compaction: {
          summary: result.summary,
          details: result.details,
          usage: result.usage,
          firstKeptEntryId: boundary,
          tokensBefore: plan.tokensBefore,
        },
      };
    } catch (error) {
      const code = mapAgentError(error);
      state.diagnostic = {
        ...state.diagnostic,
        stage: state.diagnostic?.stage ?? "transcript",
        code: code === "internal" ? "compaction_failed" : code,
        httpStatus: agentHttpStatus(error),
      };
      state.failure =
        state.signal?.aborted || state.operationSignal?.aborted || event.signal.aborted
          ? "aborted"
          : code === "internal"
            ? "compaction_failed"
            : code;
      // pi swallows hook exceptions and otherwise falls back to its unfiltered default summary.
      return { cancel: true };
    }
  });
  pi.on("session_compact", () => finishCompaction(state, "done"));
  pi.on("session_compact_failed", (event) => {
    // A second provider overflow can be refused by pi before it invokes the compaction hook.
    // No checkpoint started in that case, and the provider's fixed code remains the error.
    if (
      !state.pending &&
      event.reason === "overflow" &&
      state.accounting?.responseError?.code === "context_overflow" &&
      !state.operationSignal?.aborted &&
      !state.signal?.aborted &&
      !event.aborted
    )
      return;
    state.failure ??= state.signal?.aborted || event.aborted ? "aborted" : "compaction_failed";
    finishCompaction(state, state.failure === "aborted" ? "aborted" : "error");
  });
}
