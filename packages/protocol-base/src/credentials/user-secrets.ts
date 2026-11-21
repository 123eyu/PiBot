import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

export const SecretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const SecretAssignmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({
    kind: z.literal("bots"),
    bots: z
      .array(IdSchema)
      .min(1)
      .max(64)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
]);
export type SecretAssignment = z.output<typeof SecretAssignmentSchema>;
export const UserSecretMetaSchema = z.strictObject({
  name: SecretNameSchema,
  description: z.string().max(4096),
  assignment: SecretAssignmentSchema,
  hasValue: z.boolean(),
  revision: z.number().int().positive().safe(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type UserSecretMeta = z.output<typeof UserSecretMetaSchema>;
