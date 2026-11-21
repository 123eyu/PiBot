import { z } from "zod";

/** No C0 control characters or DEL; shared by every computer-use free-text field shown in the UI. */
export function plainText(value: string): boolean {
  return [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
}

/**
 * App identity used by grants, the blocklist and steps. Each platform driver maps its native
 * identity into this one string so policy never needs platform branches:
 * macOS bundle ID (`com.apple.iWork.Keynote`), Windows executable file name (`powerpnt.exe`),
 * Linux desktop entry ID without `.desktop` (`org.gnome.Terminal`). Comparison is
 * case-insensitive because Windows file names and some bundle IDs differ only by case.
 */
export const ComputerAppIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  // Control characters and path separators would let a forged ID alias a file path in logs or UI.
  .refine((v) => plainText(v) && !/[/\\]/.test(v), "Invalid app ID");
/** The Bot's own browser is listed beside desktop apps on the grant card. */
export const BOT_BROWSER_APP_ID = "pibot.browser";
export const ComputerAppSchema = z.strictObject({
  id: ComputerAppIdSchema,
  name: z.string().trim().min(1).max(200),
});
export const MAX_COMPUTER_APPS = 50;
export function sameAppId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
function uniqueIds(ids: readonly string[]): boolean {
  return new Set(ids.map((id) => id.toLowerCase())).size === ids.length;
}
/** A non-empty, duplicate-free app ID list; every grant and the always-list use this shape. */
export const ComputerAppIdListSchema = z
  .array(ComputerAppIdSchema)
  .min(1)
  .max(MAX_COMPUTER_APPS)
  .refine(uniqueIds, "Duplicate app");
export const ComputerAppListSchema = z
  .array(ComputerAppSchema)
  .min(1)
  .max(MAX_COMPUTER_APPS)
  .refine((apps) => uniqueIds(apps.map((app) => app.id)), "Duplicate app");
/** "task" is the spec's 30-minute default; "today" ends at local midnight computed by brain. */
export const ComputerGrantDurationSchema = z.enum(["task", "today"]);
export const COMPUTER_TASK_GRANT_MS = 30 * 60 * 1000;

/**
 * Extra payload carried by a `category: "computer"` approval so the card can render without
 * another round trip. Blocklisted apps are listed (locked) so the user sees why they are missing.
 */
export const ComputerApprovalRequestSchema = z
  .strictObject({
    apps: z
      .array(
        ComputerAppSchema.extend({
          suggested: z.boolean(),
          blocked: z.boolean(),
        }),
      )
      .min(1)
      .max(MAX_COMPUTER_APPS)
      .refine((apps) => uniqueIds(apps.map((app) => app.id)), "Duplicate app")
      .refine((apps) => apps.every((app) => !(app.blocked && app.suggested)), "Blocked app"),
    reason: z.enum(["first", "new_app", "expired", "coordinates"]),
    coordinatesRequested: z.boolean(),
    // Older cards have no capability fact; clients must not infer support from the vendor.
    modelAcceptsImages: z.boolean().optional(),
    // Screenshots go to the model vendor; null only for a local model that sends nothing out.
    providerName: z.string().trim().min(1).max(200).nullable(),
    // Apps already covered by the Bot's always-list; shown pre-checked and not re-asked.
    alwaysAppIds: z.array(ComputerAppIdSchema).max(MAX_COMPUTER_APPS),
  })
  .refine((v) => v.apps.some((app) => !app.blocked), "No selectable app");

export type ComputerAppId = z.infer<typeof ComputerAppIdSchema>;
export type ComputerApp = z.infer<typeof ComputerAppSchema>;
export type ComputerGrantDuration = z.infer<typeof ComputerGrantDurationSchema>;
export type ComputerApprovalRequest = z.infer<typeof ComputerApprovalRequestSchema>;
