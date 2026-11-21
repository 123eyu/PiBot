import { z } from "zod";

/**
 * The restart notice is one message per conversation whose content is a fixed model-facing
 * text plus one line per command id. The renderer must not show raw ids or mixed languages, so the
 * counts are stored structurally in `usage` instead of being parsed back out of the content.
 * Older rows lack this field and fall back to the count-less notice.
 */
export const BackgroundRestartUsageSchema = z.strictObject({
  /** Commands the batch moved to stopped. */
  stopped: z.number().int().nonnegative(),
  /** Commands whose stop could not be certified yet; cleanup keeps retrying. */
  unverified: z.number().int().nonnegative(),
});

export type BackgroundRestartUsage = z.infer<typeof BackgroundRestartUsageSchema>;

export function backgroundRestartUsage(usage: unknown): BackgroundRestartUsage | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const parsed = BackgroundRestartUsageSchema.safeParse(
    (usage as { backgroundRestart?: unknown }).backgroundRestart,
  );
  return parsed.success ? parsed.data : undefined;
}

/** The restart notice is the one system event that must replace its model-facing content. */
export function isBackgroundRestart(usage: unknown): boolean {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  const value = usage as { systemEvent?: unknown; trigger?: unknown };
  return value.systemEvent === true && value.trigger === "background_restart";
}
