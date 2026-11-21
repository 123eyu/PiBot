import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

const count = z.number().int().nonnegative().safe();

/**
 * Automatic continuations an earlier process left unfinished, per topic. Startup never
 * resumes them; the topic shows a prompt and only the user's confirmation re-checks and queues
 * them. Counts only: no prompt, plan or result text crosses this boundary.
 */
export const ContinuationPendingSchema = z.strictObject({
  conversationId: IdSchema,
  count,
});
export type ContinuationPending = z.infer<typeof ContinuationPendingSchema>;

export const ContinuationResumeResultSchema = z.strictObject({
  /** Chains queued again after every admission rule was re-checked. */
  resumed: count,
  /** Chains whose frozen source, plan, mode or budget no longer holds; their intents are gone. */
  dropped: count,
  /** Plans still paused for the user or a review; confirming a restart does not lift that. */
  kept: count,
  /** Chains not queued yet because the topic is busy; the prompt stays for them. */
  busy: count,
});
export type ContinuationResumeResult = z.infer<typeof ContinuationResumeResultSchema>;

export const ContinuationMethods = {
  "continuations.list": {
    params: z.strictObject({
      after: IdSchema.optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    result: z.strictObject({
      items: z.array(ContinuationPendingSchema).max(200),
      nextAfter: IdSchema.nullable(),
    }),
  },
  "continuations.resume": {
    params: z.strictObject({ conversationId: IdSchema, confirmed: z.literal(true) }),
    result: ContinuationResumeResultSchema,
  },
  "continuations.discard": {
    params: z.strictObject({ conversationId: IdSchema }),
    result: z.strictObject({ discarded: count }),
  },
} as const;

export const ContinuationEvents = {
  /** `count: 0` clears the topic's prompt (resumed, discarded, or dropped by a later check). */
  "continuations.pending": ContinuationPendingSchema,
} as const;
