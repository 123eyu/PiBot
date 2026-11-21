import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
export const PhoneRunnerReceiptSchema = z.strictObject({
  clientId: IdSchema,
  opId: IdSchema,
  idempotencyKey: IdSchema.optional(),
  target: z.string().regex(/^runner:[a-f0-9]{64}$/),
  cwd: z.string().max(32768),
  tool: z.string().max(80),
  at: z.iso.datetime(),
  command: z.string().max(16384).optional(),
  path: z.string().max(32768).optional(),
  approved: z.boolean(),
  outcome: z.enum(["pending", "denied", "done", "failed", "unknown"]),
  reason: z.string().max(200),
  summary: z.string().max(4000),
  commandResult: z
    .strictObject({
      exitCode: z.number().int().nullable(),
      timedOut: z.boolean(),
      stopped: z.boolean(),
      durationMs: z.number().nonnegative(),
    })
    .optional(),
  change: z
    .strictObject({
      path: z.string().max(32768),
      bytes: z.number().int().nonnegative(),
      afterHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .optional(),
});
