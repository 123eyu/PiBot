import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { ExecutionLimitsSchema, ExecutionModeSchema } from "../execution/modes.ts";

export const GroupExecutionSettingsSchema = z.strictObject({
  groupId: IdSchema,
  mode: ExecutionModeSchema,
  limits: ExecutionLimitsSchema,
  version: z.number().int().nonnegative().safe(),
  updatedAt: z.iso.datetime().nullable(),
});
const count = z.number().int().nonnegative().safe();
/** Totals count distinct budget roots; runtime additionally enforces caps across the whole cycle. */
export const GroupExecutionUsageSchema = z.strictObject({
  groupId: IdSchema,
  conversationId: IdSchema,
  cycleId: IdSchema.nullable(),
  rootCount: count,
  totals: z.strictObject({
    activeMillis: z.number().nonnegative().finite(),
    tools: count,
    requests: count,
    childTasks: count,
    activeChildren: count,
    maxDepth: count,
    observedTokens: z.number().nonnegative().finite(),
    knownCostUsd: z.number().nonnegative().finite(),
    unknownUsageRequests: count,
    unknownCostRequests: count,
    exhaustedRoots: count,
    /** Subset stopped by the repetition guard rather than a spending/time cap. */
    repeatedRoots: count.optional(),
  }),
});
export const GroupExecutionMethods = {
  "groups.execution.get": {
    params: z.strictObject({ groupId: IdSchema }),
    result: GroupExecutionSettingsSchema,
  },
  "groups.execution.set": {
    params: z
      .strictObject({
        groupId: IdSchema,
        expectedVersion: count,
        limits: ExecutionLimitsSchema.optional(),
        mode: ExecutionModeSchema.optional(),
      })
      .refine((value) => value.mode !== undefined || value.limits !== undefined),
    result: GroupExecutionSettingsSchema,
  },
  "groups.execution.usage": {
    params: z.strictObject({
      groupId: IdSchema,
      conversationId: IdSchema,
      cycleId: IdSchema.nullable().optional(),
    }),
    result: GroupExecutionUsageSchema,
  },
} as const;
export const GroupExecutionEvents = {
  "groups.execution.changed": GroupExecutionSettingsSchema,
} as const;
export type GroupExecutionSettings = z.infer<typeof GroupExecutionSettingsSchema>;
export type GroupExecutionUsage = z.infer<typeof GroupExecutionUsageSchema>;
