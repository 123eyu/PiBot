import { IdSchema, PhoneControlGrantsSchema } from "@pibot/protocol-base";
import { z } from "zod";

export const RunnerControlViewSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        runnerDeviceId: IdSchema,
        phoneId: IdSchema,
        editable: z.boolean(),
        name: z.string().max(200),
        enabled: z.boolean(),
        revision: z.number().int().nonnegative(),
        expiresAt: z.number().nullable(),
        state: z.enum(["pending", "ready", "unsupported", "revoke_pending", "off"]),
      }),
    )
    .max(100),
  nextAfter: IdSchema.nullable(),
});
export const RunnerControlMethods = {
  "remote.runnerControl.get": {
    params: z
      .strictObject({
        phoneId: IdSchema.optional(),
        runnerDeviceId: IdSchema.optional(),
        after: IdSchema.optional(),
      })
      .refine((v) => !!v.phoneId !== !!v.runnerDeviceId),
    result: RunnerControlViewSchema,
  },
  "remote.runnerControl.set": {
    params: z.strictObject({
      phoneId: IdSchema,
      runnerDeviceId: IdSchema,
      enabled: z.boolean(),
      expectedRevision: z.number().int().nonnegative().safe(),
    }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  "remote.runnerControl.pull": {
    params: z.strictObject({ after: IdSchema.optional() }),
    result: z.strictObject({ grants: PhoneControlGrantsSchema, nextAfter: IdSchema.nullable() }),
  },
} as const;
