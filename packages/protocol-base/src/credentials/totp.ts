import { z } from "zod";

/** SecretStore payload only. No public RPC returns this shape. */
export const CredentialTotpSecretSchema = z.strictObject({
  secret: z
    .string()
    .min(16)
    .max(1024)
    .regex(/^[A-Z2-7]+$/),
  algorithm: z.enum(["SHA1", "SHA256", "SHA512"]),
  digits: z.union([z.literal(6), z.literal(8)]),
  period: z.number().int().min(1).max(300),
});
