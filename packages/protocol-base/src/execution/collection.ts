import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { ExecutionScopeSchema, TodoPlanSchema } from "./modes.ts";

export const ArchivedPlanSchema = TodoPlanSchema.extend({
  id: IdSchema,
  archivedAt: z.iso.datetime(),
});
export const ExecutionCollectionChangeSchema = ExecutionScopeSchema.extend({
  kind: z.enum(["plan", "task"]),
  action: z.enum(["archive", "restore", "delete"]),
  id: IdSchema.optional(),
  expectedVersion: z.number().int().nonnegative().safe(),
}).refine((value) => !(value.kind === "task" || value.action === "restore") || !!value.id);
export const ExecutionCollectionMethods = {
  "execution.collection.change": {
    params: ExecutionCollectionChangeSchema,
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "execution.plans.archived": {
    params: ExecutionScopeSchema.extend({
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    result: z.strictObject({
      items: z.array(ArchivedPlanSchema).max(50),
      nextBefore: IdSchema.nullable(),
    }),
  },
} as const;
export const ExecutionCollectionEvents = {
  "execution.collection.changed": ExecutionScopeSchema,
} as const;
export type ArchivedPlan = z.infer<typeof ArchivedPlanSchema>;
export type ExecutionCollectionChange = z.infer<typeof ExecutionCollectionChangeSchema>;
