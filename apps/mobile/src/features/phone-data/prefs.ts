import { z } from "zod";
import type { LocalData } from "../../storage/types.ts";

/**
 * What each paired computer may read from this phone. Everything is off until the owner
 * turns it on, per computer; `pref:` rows are removed when that computer is unpaired.
 */
const PrefsSchema = z.object({
  notifications: z.boolean().default(false),
  calls: z.boolean().default(false),
  ui: z.boolean().default(false),
  shell: z.boolean().default(false),
  media: z.boolean(),
  smsCode: z.boolean(),
  /** Android without Google services: scan the last 10 minutes of SMS (READ_SMS), opt-in. */
  smsFallback: z.boolean(),
});
export type PhoneDataPrefs = z.infer<typeof PrefsSchema>;
export const DEFAULT_PHONE_DATA: PhoneDataPrefs = {
  notifications: false,
  calls: false,
  ui: false,
  shell: false,
  media: false,
  smsCode: false,
  smsFallback: false,
};
const LogSchema = z
  .array(
    z.object({
      at: z.iso.datetime(),
      category: z.enum(["media", "media_get", "sms_code", "calls", "notifications"]),
      count: z.number().int().nonnegative().max(100),
      outcome: z.string().max(40),
    }),
  )
  .max(50);
export type PhoneDataLogEntry = z.infer<typeof LogSchema>[number];
const prefsKey = (computerId: string) => `pref:${computerId}:phoneData`;
const logKey = (computerId: string) => `pref:${computerId}:phoneDataLog`;

export async function readPhoneDataPrefs(data: LocalData, computerId: string) {
  const stored = PrefsSchema.safeParse(await data.get(prefsKey(computerId)));
  return stored.success ? stored.data : DEFAULT_PHONE_DATA;
}
export function writePhoneDataPrefs(
  data: LocalData,
  computerId: string,
  prefs: z.input<typeof PrefsSchema>,
) {
  return data.put(prefsKey(computerId), PrefsSchema.parse(prefs));
}
export async function readPhoneDataLog(data: LocalData, computerId: string) {
  const stored = LogSchema.safeParse(await data.get(logKey(computerId)));
  return stored.success ? stored.data : [];
}
/** "Recently read": what, when and how many; never the photos or codes themselves. */
export async function appendPhoneDataLog(
  data: LocalData,
  computerId: string,
  entry: PhoneDataLogEntry,
) {
  const rows = await readPhoneDataLog(data, computerId);
  await data.put(logKey(computerId), LogSchema.parse([entry, ...rows].slice(0, 50)));
}
