import { z } from "zod";

/** Host observations only; no script body or approval capability crosses this boundary. */
export const GitHookFactsSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["unsupported", "confirmation-required"]),
  reason: z.enum([
    "unsupported_syntax",
    "unsupported_scope",
    "unsupported_config",
    "unsupported_entry",
    "changed",
    "once_required",
  ]),
  authority: z.literal("none"),
  cwd: z.string().min(1).max(4096).optional(),
  hookPath: z.string().min(1).max(4096).optional(),
  hookHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  programHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  program: z.string().min(1).max(4096).optional(),
  args: z.array(z.string().max(4096)).max(3).optional(),
  beforeVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type GitHookFacts = z.infer<typeof GitHookFactsSchema>;
