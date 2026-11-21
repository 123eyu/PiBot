import {
  SafeSecretSchema,
  SecretAssignmentSchema,
  SecretNameSchema,
  UserSecretMetaSchema,
} from "@pibot/protocol-base";
import { z } from "zod";
export const UserSecretMethods = {
  "secrets.list": {
    params: z.strictObject({
      cursor: SecretNameSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    result: z.strictObject({
      items: z.array(UserSecretMetaSchema).max(100),
      nextCursor: SecretNameSchema.optional(),
    }),
  },
  "secrets.set": {
    params: z.strictObject({
      name: SecretNameSchema,
      value: z
        .union([SafeSecretSchema, z.literal("")])
        .refine((value) => !value.includes("\0"), "Unsafe secret value")
        .optional(),
      description: z
        .string()
        .max(4096)
        .refine((value) => !value.includes("\0"))
        .optional(),
      assignment: SecretAssignmentSchema.optional(),
      // Absent means create, present means compare-and-swap update. Names are immutable.
      expectedRevision: z.number().int().positive().safe().optional(),
    }),
    result: z.strictObject({ secret: UserSecretMetaSchema }),
  },
  "secrets.delete": {
    params: z.strictObject({
      name: SecretNameSchema,
      expectedRevision: z.number().int().positive().safe(),
    }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
} as const;
export const UserSecretEvents = {
  "secrets.changed": z.strictObject({
    action: z.enum(["set", "removed"]),
    name: SecretNameSchema,
    revision: z.number().int().positive().safe(),
    meta: UserSecretMetaSchema.nullable(),
  }),
} as const;
