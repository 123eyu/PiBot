import { z } from "zod";

const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const PHONE_CONTROL_TTL_MS = 24 * 60 * 60 * 1000;
export const PhoneControlBodySchema = z
  .strictObject({
    version: z.literal(1),
    issuer: key,
    phone: key,
    runner: key,
    runnerId: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().positive().safe(),
    rotation: key,
    issuedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().positive().safe(),
    enabled: z.boolean(),
    stunUrl: z
      .string()
      .max(2048)
      .regex(/^stun:(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$/)
      .nullable(),
    capabilities: z.array(z.enum(["runner.exec", "runner.files", "runner.background"])).max(3),
  })
  .refine((v) => v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= PHONE_CONTROL_TTL_MS);
export const PhoneControlGrantSchema = z.strictObject({
  body: PhoneControlBodySchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export const PhoneControlGrantsSchema = z.array(PhoneControlGrantSchema).max(100);
export type PhoneControlGrant = z.infer<typeof PhoneControlGrantSchema>;
export type PhoneControlBody = z.infer<typeof PhoneControlBodySchema>;
export const PhoneControlRunnerMethods = {
  "runner.phoneAuthorizations.set": {
    params: z.strictObject({ grants: PhoneControlGrantsSchema }),
    result: z.strictObject({ version: z.literal(1) }),
  },
} as const;
