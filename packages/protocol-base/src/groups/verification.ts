import { z } from "zod";
import { AbsolutePathSchema } from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";

/** Template hints select reviewers, never authorize tools or file access. */
export const VerificationKindSchema = z.enum([
  "code",
  "research",
  "data",
  "content",
  "learning",
  "image",
]);
export type VerificationKind = z.infer<typeof VerificationKindSchema>;
export const GroupVerificationRulesSchema = z
  .record(
    z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    z.array(VerificationKindSchema).max(6),
  )
  .refine((rules) => Object.keys(rules).length <= 20);
export type GroupVerificationRules = z.infer<typeof GroupVerificationRulesSchema>;

export const GroupVerificationSchema = z.strictObject({
  sourceRunId: IdSchema,
  authorBotId: IdSchema,
  workflowRunId: IdSchema.optional(),
  sources: z
    .array(
      z.strictObject({
        stepId: z.string().min(1).max(100),
        runId: IdSchema,
        authorBotId: IdSchema,
      }),
    )
    .min(1)
    .max(20)
    .optional(),
  workspaceRoot: AbsolutePathSchema.max(4096),
  workspaceRevision: z.number().int().nonnegative(),
  target: z.string().min(1).max(200),
  revision: z.number().int().nonnegative().optional(),
  files: z
    .array(z.string().min(1).max(4096))
    .min(1)
    .max(500)
    .refine((files) => files.reduce((count, file) => count + file.length, 0) <= 16000),
  truncated: z.boolean(),
});
export type GroupVerification = z.infer<typeof GroupVerificationSchema>;
