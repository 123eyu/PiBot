import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

export const GROUP_PLAN_FORMAT_LIMIT = 6;
export const GroupPlanLimitSchema = z.strictObject({ groupId: IdSchema, cycleId: IdSchema });
/** One bounded state per group; a new user cycle replaces the previous counters. */
export const GroupPlanAttemptsSchema = z.strictObject({
  cycleId: IdSchema,
  errors: z.number().int().nonnegative(),
  extensions: z.number().int().nonnegative(),
  status: z.enum(["open", "waiting", "solo", "ended"]),
  delegationRequested: z.boolean().optional(),
  planningOnly: z.boolean().optional(),
  continuationRunId: IdSchema.optional(),
  messageId: IdSchema.nullable(),
  sourceRunId: IdSchema,
  lastCall: z.string().max(300).nullable(),
});
export type GroupPlanAttempts = z.infer<typeof GroupPlanAttemptsSchema>;
