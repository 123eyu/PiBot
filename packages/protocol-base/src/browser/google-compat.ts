import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

/**
 * Google compatibility mode, per Bot. While on, this Bot's browser presents itself as
 * Firefox on Google's sign-in and account hosts only (Google refuses sign-in from the Electron
 * engine, measured in Google sign-in tests); every other site keeps the Chromium
 * identity. Off by default; only the user switches it, and each change is audited.
 */
export const BotGoogleCompatSchema = z.strictObject({
  botId: IdSchema,
  enabled: z.boolean(),
  /** When it was turned on; null while off. */
  enabledAt: z.iso.datetime().nullable(),
});
export const GroupGoogleCompatSchema = BotGoogleCompatSchema.omit({ botId: true }).extend({
  groupId: IdSchema,
  botId: z.never().optional(),
});
export const ScopedGoogleCompatSchema = z.union([
  BotGoogleCompatSchema.extend({ groupId: z.never().optional() }),
  GroupGoogleCompatSchema,
]);
export const GoogleCompatScopeSchema = z.union([
  z.strictObject({ botId: IdSchema, groupId: z.never().optional() }),
  z.strictObject({ groupId: IdSchema, botId: z.never().optional() }),
]);
export type BotGoogleCompat = z.infer<typeof BotGoogleCompatSchema>;

export type GroupGoogleCompat = z.infer<typeof GroupGoogleCompatSchema>;
export type ScopedGoogleCompat = z.infer<typeof ScopedGoogleCompatSchema>;
export type GoogleCompatScope = z.infer<typeof GoogleCompatScopeSchema>;
