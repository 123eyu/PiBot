import { z } from "zod";

/** Program evidence only: observed URLs do not prove the claims made about them. */
export const ReplyCitationCheckSchema = z.strictObject({
  unread: z.number().int().min(0).max(100),
  incomplete: z.boolean(),
});
export function replyCitationCheck(message: { usage: unknown }) {
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
  const parsed = ReplyCitationCheckSchema.safeParse(
    (usage as Record<string, unknown>).replyCitations,
  );
  return parsed.success ? parsed.data : undefined;
}
