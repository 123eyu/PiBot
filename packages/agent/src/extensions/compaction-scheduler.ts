import type {
  CompactionEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { mapAgentError } from "../core/errors.ts";
import { contextBudget } from "../runtime/context-budget.ts";
import { historyTokens, referenceTokens, textTokens } from "../runtime/context-estimate.ts";
import {
  type CheckpointPlan,
  checkpointBoundary,
  makeCheckpointPlan,
  planStillApplies,
} from "./checkpoint-plan.ts";
import { type CheckpointResult, redactCheckpoint } from "./checkpoint-result.ts";
import { summarizeCheckpoint } from "./checkpoint-summary.ts";
import { type CompactionState, finishCompaction } from "./compaction.ts";
import type { PromptState } from "./prompt-context.ts";

type Candidate = {
  plan: CheckpointPlan;
  scope: string;
  result?: CheckpointResult;
  ready: boolean;
  done: Promise<void>;
  controller: AbortController;
};

/** Candidates cache progress only; SDK boundary drafts are the streaming session's sole writer. */
export class CompactionScheduler {
  private candidate?: Candidate;
  private lastAttempt?: string;
  constructor(
    private readonly state: CompactionState,
    private readonly prompt?: PromptState,
  ) {}
  cancel() {
    this.candidate?.controller.abort();
  }
  async drain() {
    await this.candidate?.done;
  }
  async take(branch: SessionEntry[]) {
    await this.drain();
    const candidate = this.candidate;
    this.candidate = undefined;
    if (
      candidate?.result &&
      candidate.scope === (this.state.scopeVersion?.() ?? "") &&
      planStillApplies(candidate.plan, branch) &&
      this.fits(candidate.result)
    )
      return {
        plan: candidate.plan,
        result: redactCheckpoint(candidate.result, this.state.redact),
      };
    const cached = this.state.cache?.find(this.state.identity?.() ?? "", branch);
    if (!cached || !this.fits(cached.result)) return;
    return { plan: cached.plan, result: redactCheckpoint(cached.result, this.state.redact) };
  }
  private fits(result: CheckpointResult) {
    return (
      textTokens(result.summary) <
      contextBudget(this.state.contextWindow ?? 32_000).triggerTokens / 2
    );
  }
  private tokens(ctx: ExtensionContext) {
    const budget = contextBudget(ctx.model?.contextWindow ?? 0);
    return Math.ceil(
      ((this.state.estimateHistory?.(ctx.sessionManager.buildSessionProjection().messages) ??
        historyTokens(ctx.sessionManager.buildSessionProjection().messages)) +
        referenceTokens(this.prompt?.current, Math.floor(budget.triggerTokens * 0.2))) *
        (this.state.estimateScale ?? 1),
    );
  }
  private launch(ctx: ExtensionContext, force = false): Candidate | undefined {
    if (!ctx.model || this.state.failure || this.state.signal?.aborted || ctx.signal?.aborted)
      return;
    if (!Number.isFinite(contextBudget(ctx.model.contextWindow).triggerTokens)) return;
    const plan = makeCheckpointPlan(
      ctx.sessionManager.getBranch(),
      ctx.model.contextWindow,
      this.state.redact,
    );
    if (!plan) return;
    const scope = this.state.scopeVersion?.() ?? "";
    const key = `${scope}:${plan.prefixHash}`;
    if (!force && key === this.lastAttempt) return;
    this.lastAttempt = key;
    const controller = new AbortController();
    const local: CompactionState = {
      ...this.state,
      background: undefined,
      backgroundTask: true,
      pending: undefined,
      diagnostic: undefined,
      // Background progress is diagnostic, not a start/end of the visible compaction indicator.
      activity: (event) => this.state.activity?.({ ...event, phase: "progress" }),
      progress: async (result) =>
        this.state.cache?.candidate(this.state.identity?.() ?? "", plan, result),
    };
    const candidate: Candidate = { plan, scope, ready: false, controller, done: Promise.resolve() };
    candidate.done = summarizeCheckpoint(
      plan,
      ctx.modelRegistry,
      ctx.model,
      local,
      controller.signal,
    )
      .then(
        (result) => {
          candidate.result = result;
        },
        (error) => {
          if (!controller.signal.aborted && !this.state.signal?.aborted)
            this.state.activity?.({
              phase: "progress",
              reason: "threshold",
              entryCount: plan.messages.length,
              failure: { stage: "summary", ...local.diagnostic, code: mapAgentError(error) },
            });
        },
      )
      .finally(() => {
        candidate.ready = true;
      });
    this.candidate = candidate;
    return candidate;
  }
  start(ctx: ExtensionContext) {
    if (
      !ctx.model ||
      !Number.isFinite(contextBudget(ctx.model.contextWindow).triggerTokens) ||
      this.candidate ||
      this.tokens(ctx) < contextBudget(ctx.model.contextWindow).backgroundFromTokens
    )
      return;
    this.launch(ctx);
  }
  async boundary(
    event: TurnEndEvent,
    ctx: ExtensionContext,
  ): Promise<{ entries: CompactionEntryDraft[] } | undefined> {
    if (
      !ctx.model ||
      !Number.isFinite(contextBudget(ctx.model.contextWindow).triggerTokens) ||
      event.outcome !== "completed" ||
      event.entries.length ||
      this.state.failure
    )
      return;
    const required = this.tokens(ctx) >= contextBudget(ctx.model.contextWindow).triggerTokens;
    if (
      this.candidate &&
      (this.candidate.scope !== (this.state.scopeVersion?.() ?? "") ||
        !planStillApplies(this.candidate.plan, ctx.sessionManager.getBranch()))
    ) {
      this.cancel();
      await this.drain();
      this.candidate = undefined;
    }
    if (!this.candidate && required) this.launch(ctx, true);
    if (!this.candidate) {
      if (event.message.role === "assistant" && event.message.stopReason === "toolUse")
        this.start(ctx);
      return;
    }
    if (!this.candidate.ready && !required) return;
    if (required) {
      this.state.pending = {
        reason: "threshold",
        entryCount: this.candidate.plan.messages.length,
        started: Date.now(),
      };
      this.state.activity?.({
        phase: "start",
        reason: "threshold",
        entryCount: this.candidate.plan.messages.length,
      });
    }
    const candidate = await this.take(ctx.sessionManager.getBranch());
    if (ctx.signal?.aborted || this.state.signal?.aborted || this.state.operationSignal?.aborted) {
      finishCompaction(this.state, "aborted");
      return;
    }
    if (!candidate) return;
    if (!this.state.pending) {
      this.state.pending = {
        reason: "threshold",
        entryCount: candidate.plan.messages.length,
        started: Date.now(),
      };
      this.state.activity?.({
        phase: "start",
        reason: "threshold",
        entryCount: candidate.plan.messages.length,
      });
    }
    return {
      entries: [
        {
          type: "compaction",
          summary: candidate.result.summary,
          details: candidate.result.details,
          usage: candidate.result.usage,
          firstKeptEntryId: checkpointBoundary(
            candidate.plan,
            candidate.result.consumedMessages,
            ctx.sessionManager.getBranch(),
          ),
        },
      ],
    };
  }
}
export function registerCompactionScheduler(
  pi: ExtensionAPI,
  state: CompactionState,
  prompt?: PromptState,
) {
  const scheduler = new CompactionScheduler(state, prompt);
  state.background = scheduler;
  pi.on("tool_execution_start", (_event, ctx) => {
    try {
      scheduler.start(ctx);
    } catch (error) {
      state.failure = mapAgentError(error);
      ctx.abort();
    }
  });
  pi.on("turn_end", async (event, ctx) => {
    try {
      return await scheduler.boundary(event, ctx);
    } catch (error) {
      state.failure = mapAgentError(error);
      ctx.abort();
    }
  });
  pi.on("agent_settled", () => scheduler.drain());
  pi.on("session_shutdown", () => {
    scheduler.cancel();
    return scheduler.drain();
  });
}
