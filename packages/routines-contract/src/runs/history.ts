import { AvatarImageSchema, IdSchema, PageSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { CanonicalTimeSchema, RoutineRunViewSchema } from "../definitions/entities.ts";

export const RoutineHistoryQuerySchema = PageSchema.extend({
  botId: IdSchema.optional(),
  from: CanonicalTimeSchema.optional(),
  // Batch rereads update already expanded history without one RPC per execution.
  ids: z
    .array(IdSchema)
    .min(1)
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length)
    .optional(),
}).refine((query) => !query.ids || !query.before, "Batch reads cannot carry a page cursor");
// entities imports routine event schemas; this public projection must stay independent.
export const RoutineHistoryBotSchema = z.strictObject({
  name: z.string().max(200),
  avatarShape: z.string().min(1).max(200),
  avatarColor: z.string().min(1).max(200),
  avatarEyes: z.string().min(1).max(200),
  avatarImage: AvatarImageSchema.optional(),
  archivedAt: z.iso.datetime().nullable().optional(),
});
export const RoutineHistoryViewSchema = RoutineRunViewSchema.extend({
  taskName: z.string().max(200).nullable(),
  taskDeleted: z.boolean(),
  bot: RoutineHistoryBotSchema.nullable(),
});
export type RoutineHistoryQuery = z.infer<typeof RoutineHistoryQuerySchema>;
export type RoutineHistoryView = z.infer<typeof RoutineHistoryViewSchema>;
