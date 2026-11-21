import { CanonicalTimeSchema, IdSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { PowerEventSchema, RoutineRunRecordSchema } from "../definitions/entities.ts";

export const RoutineActiveViewSchema = RoutineRunRecordSchema.pick({
  id: true,
  scheduledFor: true,
  startedAt: true,
  conversationId: true,
}).extend({ status: z.enum(["scheduled", "running", "waiting"]) });
export const RoutineResultViewSchema = RoutineRunRecordSchema.pick({
  id: true,
  reason: true,
  scheduledFor: true,
  finishedAt: true,
  summary: true,
  errorCode: true,
  conversationId: true,
  triggerMessageId: true,
}).extend({ status: z.enum(["done", "failed", "cancelled", "timeout"]) });
export const RoutineOnceOutcomeSchema = RoutineResultViewSchema.extend({
  status: RoutineRunRecordSchema.shape.status,
});
export const RoutineRowStateSchema = z.strictObject({
  routineId: IdSchema,
  nextAt: CanonicalTimeSchema.nullable(),
  active: RoutineActiveViewSchema.nullable(),
  lastResult: RoutineResultViewSchema.nullable(),
  onceOutcome: RoutineOnceOutcomeSchema.nullable().optional(),
  attentionCount: z.number().int().nonnegative().safe(),
  /**
   * The task's own folders cannot be resolved. The list annotation already reports this
   * through preauthorizations; without any, this row is the only place that can say so.
   */
  workspaceUnavailable: z.enum(["workspace", "runner"]).optional(),
  /**
   * Names (never paths) of the folders that no longer exist, so the row can say which
   * folder to pick again instead of only "folder unavailable".
   */
  workspaceMissing: z.array(z.string().min(1).max(200)).max(8).optional(),
  /**
   * Reference folders a run skips because they no longer exist. Lighter than
   * `workspaceMissing`: the task still runs, so the row only suggests removing them.
   */
  workspaceReferenceMissing: z.array(z.string().min(1).max(200)).max(8).optional(),
});
export const RoutineRowsSchema = z.strictObject({
  at: CanonicalTimeSchema,
  pausedUntil: CanonicalTimeSchema.nullable(),
  rows: z.array(RoutineRowStateSchema).max(200),
});
export const RoutinePlannedCursorSchema = z.strictObject({
  at: CanonicalTimeSchema,
  routineId: IdSchema,
});
export const RoutinePlannedPointSchema = RoutinePlannedCursorSchema.extend({
  botId: IdSchema,
  conversationId: IdSchema,
});
export const RoutinePlannedPageSchema = z.strictObject({
  from: CanonicalTimeSchema,
  to: CanonicalTimeSchema,
  asOf: CanonicalTimeSchema,
  points: z.array(RoutinePlannedPointSchema).max(200),
  nextCursor: RoutinePlannedCursorSchema.nullable(),
});
export const PowerContextSchema = z.strictObject({
  state: z.enum(["awake", "suspended", "unknown"]),
  event: PowerEventSchema.nullable(),
});
