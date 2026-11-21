import { z } from "zod";

/**
 * The background workers whose silent failures nobody noticed for days (memory
 * extraction, memory organization, routine runs, skill runtimes, built-in role updates). They
 * report consecutive failures here so one inbox card can say "this keeps failing, here is why".
 */
export const BackgroundTaskSchema = z.enum([
  "memory_extraction",
  "memory_organization",
  "routine_run",
  "skill_runtime",
  "builtin_update",
]);
export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>;

/**
 * Same reason three times in a row is a state, not a blip: two failures can be one flaky network
 * call and a retry, while three already means the retry loop gave up twice with the same cause.
 */
export const BACKGROUND_FAILURE_THRESHOLD = 3;

/** One streak of identical failures. A success deletes the row, which hides the inbox card. */
export const BackgroundFailureSchema = z.strictObject({
  task: BackgroundTaskSchema,
  subject: z.string(),
  subjectName: z.string().min(1).optional(),
  reasonCode: z.string().trim().min(1).max(100),
  streak: z.number().int().positive(),
  firstFailedAt: z.iso.datetime(),
  lastFailedAt: z.iso.datetime(),
});
export type BackgroundFailure = z.infer<typeof BackgroundFailureSchema>;
