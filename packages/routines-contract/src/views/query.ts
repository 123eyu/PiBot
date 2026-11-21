import {
  CanonicalTimeSchema,
  ConnectionCheckIdSchema,
  IdSchema,
  TimezoneSchema,
} from "@pibot/protocol-base";
import { z } from "zod";
import { CronExpressionSchema } from "../definitions/entities.ts";

// Identity comes from the trusted tool run, never a model-supplied Bot id.
export const RoutineQueryInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(40).optional(),
  before: IdSchema.optional(),
  limit: z.number().int().min(1).max(20).default(10),
});
export type RoutineQueryInput = z.input<typeof RoutineQueryInputSchema>;
export const RoutineQueryResultSchema = z.strictObject({
  routines: z
    .array(
      z.strictObject({
        id: IdSchema,
        name: z.string().max(40),
        version: z.number().int().positive(),
        enabled: z.boolean(),
        createdAt: CanonicalTimeSchema,
        instructionsPreview: z.string().max(200),
        triggers: z
          .array(
            z.discriminatedUnion("kind", [
              z.strictObject({
                kind: z.literal("cron"),
                expr: CronExpressionSchema,
                timezone: TimezoneSchema,
              }),
              z.strictObject({
                kind: z.literal("once"),
                at: CanonicalTimeSchema,
                timezone: TimezoneSchema,
              }),
              z.strictObject({ kind: z.literal("folder"), pathPreview: z.string().max(200) }),
              z.strictObject({
                kind: z.literal("connection"),
                check: ConnectionCheckIdSchema,
                intervalMin: z.number().int().positive(),
              }),
              z.strictObject({
                kind: z.literal("calendar"),
                event: z.enum(["before_start", "new_event"]),
                minutesBefore: z.number().int().positive(),
              }),
              /** Retired; the routine is paused until the person picks a new trigger. */
              z.strictObject({ kind: z.literal("github"), retired: z.literal(true) }),
            ]),
          )
          .max(4),
        moreTriggers: z.boolean(),
      }),
    )
    .max(20),
  nextBefore: IdSchema.nullable(),
  totalMatches: z.number().int().nonnegative().safe(),
  selectionRequired: z.boolean(),
});
