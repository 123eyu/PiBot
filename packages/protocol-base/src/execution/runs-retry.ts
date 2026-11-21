import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { ModelPreferenceSchema, ThinkingLevelSchema } from "../providers/providers.ts";

/**
 * One explicit continuation of a failed run, for a private chat, an assigned task or (later) a
 * subtask. The conversation is a parameter rather than something derived from the run, so the same
 * request can be refused when the run has moved to another topic.
 *
 * `origin` is reserved for future automatic callers and only accepts "user" for now: a caller must say
 * that a person asked, not leave it implicit.
 */
const retryTarget = {
  botId: IdSchema,
  conversationId: IdSchema,
  failedRunId: IdSchema,
  model: ModelPreferenceSchema.optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  origin: z.literal("user").optional(),
};

export const RunsRetryMethods = {
  "runs.retry": {
    params: z.discriminatedUnion("source", [
      z.strictObject({ source: z.literal("dm"), ...retryTarget }),
      z.strictObject({
        source: z.literal("group"),
        ...retryTarget,
        groupId: IdSchema,
        taskId: IdSchema,
      }),
      // Resuming an interrupted subtask. No model switch: the child keeps the frozen
      // authority and model it was created with; the version guards a double click or a stale view.
      z.strictObject({
        source: z.literal("subtask"),
        botId: IdSchema,
        conversationId: IdSchema,
        failedRunId: IdSchema,
        taskId: IdSchema,
        expectedVersion: z.number().int().nonnegative().safe(),
        verifiedSideEffects: z.boolean().optional(),
        origin: z.literal("user").optional(),
      }),
    ]),
    result: z.strictObject({ runId: IdSchema, threadId: IdSchema.optional() }),
  },
} as const;
/**
 * The user's 「继续」 on a run a restart interrupted (`interruptedRun`). The new run joins
 * the same conversation and session with the interrupted run's budget root, so the budget goes
 * on from the same ledger and the execution journal answers for calls already made: done calls
 * are not executed again, unknown ones are refused until checked. Permissions are judged again
 * under the current settings. Never automatic; a second click returns the same run.
 *
 * `raiseBudget`: the user's 「加预算继续」 on a workflow run that stopped at its cost cap
 * (`RunReceipt.budgetRaise`). The brain checks the run's own stop (budget_exhausted, ledger reason
 * `cost`), raises the root's cap by half of the cap it started with (at most three times per
 * root) and resumes it like an interrupted run: same ledger and journal, nothing done is repeated.
 *
 * Errors: invalidParams `resume_unavailable` (not an interrupted run of this conversation, or the
 * source is gone), `resume_workflow_unavailable` (its workflow skill was removed or changed
 * version), `budget_raise_unavailable` (raiseBudget on a run that did not stop at a workflow cost
 * cap), `budget_raise_limit` (the root was already raised three times); busy `Recovery source
 * changed` / `Recovery cycle changed` / `Group unavailable` / `Task no longer open` (a newer run,
 * the topic busy, the group moved on); `no_model`.
 */
export const RunsResumeMethods = {
  "runs.resume": {
    params: z.strictObject({
      botId: IdSchema,
      conversationId: IdSchema,
      runId: IdSchema,
      origin: z.literal("user").optional(),
      raiseBudget: z.literal(true).optional(),
    }),
    result: z.strictObject({ runId: IdSchema, threadId: IdSchema.optional() }),
  },
} as const;
export type RetrySource = z.input<(typeof RunsRetryMethods)["runs.retry"]["params"]>["source"];
export type RetryResult = z.output<(typeof RunsRetryMethods)["runs.retry"]["result"]>;
