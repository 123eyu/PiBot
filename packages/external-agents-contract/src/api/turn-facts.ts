import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = z.object({
  amount: z.number().nonnegative().max(1_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

/**
 * What an agent turn's reply carries in `usage.externalAgent` (written by the brain's agent run):
 * only what the agent itself reported, plus Pi Bot's own timing and approval counts. Fields the
 * agent did not report are named in `notReported`, so a view says so instead of showing zero.
 * Unknown fields are ignored: older replies parse with what they have.
 */
export const AgentTurnFactsSchema = z.object({
  externalAgent: z.object({
    name: z.string().max(200),
    steps: count.optional(),
    commands: count.optional(),
    edits: count.optional(),
    durationMs: count.optional(),
    approvals: z.object({ asked: count, allowed: count, denied: count }).optional(),
    plan: z
      .array(
        z.object({
          content: z.string().max(400),
          status: z.enum(["pending", "in_progress", "completed"]),
        }),
      )
      .max(50)
      .optional(),
    tokens: z
      .object({
        inputTokens: count.optional(),
        outputTokens: count.optional(),
        cachedReadTokens: count.optional(),
        cachedWriteTokens: count.optional(),
        thoughtTokens: count.optional(),
        totalTokens: count.optional(),
      })
      .optional(),
    cost: money.optional(),
    sessionCost: money.optional(),
    context: z.object({ used: count.optional(), size: count.optional() }).optional(),
    thoughts: z.string().max(8000).optional(),
    /** The agent's own refusal text on a failed turn (redacted, account-masked, capped). */
    errorDetail: z.string().max(1000).optional(),
    /** Per step: the paths the agent named and the output it showed (redacted, capped). */
    stepDetails: z
      .array(
        z.object({
          toolCallId: z.string().max(200),
          /** The command or path the step ran on (the agent's rawInput), capped. */
          input: z.string().max(1000).optional(),
          locations: z.array(z.string().max(400)).max(10).optional(),
          output: z.string().max(2000).optional(),
        }),
      )
      .max(100)
      .optional(),
    notReported: z.array(z.string().max(40)).max(20).default([]),
  }),
});
export type AgentTurnFacts = z.infer<typeof AgentTurnFactsSchema>["externalAgent"];

/** The facts of an agent turn's reply, or undefined for any other message. */
export function agentTurnFacts(usage: unknown): AgentTurnFacts | undefined {
  const parsed = AgentTurnFactsSchema.safeParse(usage);
  return parsed.success ? parsed.data.externalAgent : undefined;
}
