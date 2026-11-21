import { IdSchema, TimezoneSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { RoutinePartialDraftSchema, RoutineTriggerInputSchema } from "../definitions/entities.ts";

// A proposal may omit required fields; only the user's acceptance becomes a complete draft.
// A workflow binding names a skill id the model never sees; only the editor sets it.
// Connection and calendar triggers name a connection and preset the person picks in the
// editor; a Bot proposes the task and the person adds those triggers there.
export const RoutineProposeInputSchema = RoutinePartialDraftSchema.omit({
  botId: true,
  workflow: true,
}).extend({
  routineId: IdSchema.optional(),
  triggers: z
    .array(
      z.discriminatedUnion("kind", [
        RoutineTriggerInputSchema.options[0].extend({
          timezone: RoutineTriggerInputSchema.options[0].shape.timezone.optional(),
        }),
        RoutineTriggerInputSchema.options[1],
        z.strictObject({
          kind: z.literal("once"),
          at: z.string().max(100).optional(),
          localTime: z.string().max(100).optional(),
          timezone: TimezoneSchema.optional(),
          disambiguation: z.enum(["earlier", "later"]).optional(),
        }),
      ]),
    )
    .min(1)
    .max(32)
    .optional(),
  missingFields: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(200)
        .refine((v) => !["__proto__", "constructor", "prototype"].includes(v)),
    )
    .max(20)
    .optional(),
});
export type RoutineProposeInput = z.output<typeof RoutineProposeInputSchema>;
