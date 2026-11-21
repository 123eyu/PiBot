import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentError, mapAgentError } from "../core/errors.ts";
import { loadPiSdk } from "../runtime/pi-sdk.ts";
import {
  checkpointBoundary,
  checkpointSourceApplies,
  makeCheckpointPlan,
} from "./checkpoint-plan.ts";
import { checkpointUsageDelta, redactCheckpoint } from "./checkpoint-result.ts";
import { summarizeCheckpoint } from "./checkpoint-summary.ts";
import { type CompactionState, finishCompaction } from "./compaction.ts";

/** The caller owns the session writer lock until every stream and checkpoint write has drained. */
export async function compactBeforePrompt(
  session: AgentSession,
  state: CompactionState,
  all = false,
  reason: "threshold" | "overflow" = "threshold",
) {
  state.operationSignal?.throwIfAborted();
  state.signal?.throwIfAborted();
  const { ModelRegistry } = await loadPiSdk();
  state.operationSignal?.throwIfAborted();
  state.signal?.throwIfAborted();
  const model = session.model;
  if (!model || session.isStreaming) throw new AgentError("compaction_failed");
  const plan = makeCheckpointPlan(
    session.sessionManager.getBranch(),
    model.contextWindow,
    state.redact,
    all,
  );
  if (!plan) return;
  const scope = state.scopeVersion?.();
  const assertCurrent = () => {
    state.operationSignal?.throwIfAborted();
    state.signal?.throwIfAborted();
    if (
      scope !== state.scopeVersion?.() ||
      session.model !== model ||
      !checkpointSourceApplies(plan, session.sessionManager.getBranch())
    )
      throw new AgentError("context_unavailable");
  };
  state.pending = { reason, entryCount: plan.messages.length, started: Date.now() };
  let saved = 0;
  let previousUsage: import("@earendil-works/pi-ai").Usage | undefined;
  const progress: NonNullable<CompactionState["progress"]> = async (raw) => {
    const result = redactCheckpoint(raw, state.redact);
    assertCurrent();
    session.sessionManager.appendCompaction(
      result.summary,
      checkpointBoundary(plan, result.consumedMessages, session.sessionManager.getBranch()),
      plan.tokensBefore,
      result.details,
      true,
      checkpointUsageDelta(result.usage, previousUsage),
    );
    previousUsage = result.usage;
    session.refreshContext();
    saved = result.consumedMessages;
  };
  try {
    state.activity?.({ phase: "start", reason, entryCount: plan.messages.length });
    const candidate = all
      ? undefined
      : await state.background?.take?.(session.sessionManager.getBranch());
    const result =
      (candidate && redactCheckpoint(candidate.result, state.redact)) ??
      (await summarizeCheckpoint(plan, new ModelRegistry(session.modelRuntime), model, {
        ...state,
        progress,
      }));
    if (candidate) {
      // The candidate may have chosen an older prefix while tools were running.
      const source = candidate.plan;
      assertCurrent();
      session.sessionManager.appendCompaction(
        result.summary,
        checkpointBoundary(source, result.consumedMessages, session.sessionManager.getBranch()),
        source.tokensBefore,
        result.details,
        true,
        result.usage,
      );
      session.refreshContext();
    } else if (saved !== result.consumedMessages) await progress(result);
    finishCompaction(state, "done");
  } catch (error) {
    state.failure =
      state.operationSignal?.aborted || state.signal?.aborted ? "aborted" : mapAgentError(error);
    if (state.failure === "internal") state.failure = "compaction_failed";
    finishCompaction(state, state.failure === "aborted" ? "aborted" : "error");
    throw new AgentError(state.failure);
  }
}
