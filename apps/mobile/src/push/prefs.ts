import { z } from "zod";
import type { LocalData } from "../storage/types.ts";

/**
 * Per paired computer: the 通知 switch, and whether that computer holds this phone's push
 * token. `pref:` rows are outside the evicting `cache:` set and are removed on unpair.
 */
const PrefsSchema = z.object({ enabled: z.boolean(), push: z.boolean() });
export type NotifyPrefs = z.infer<typeof PrefsSchema>;
export const DEFAULT_PREFS: NotifyPrefs = { enabled: true, push: false };
const key = (computerId: string) => `pref:${computerId}:notify`;

export async function readNotifyPrefs(data: LocalData, computerId: string) {
  const stored = PrefsSchema.safeParse(await data.get(key(computerId)));
  return stored.success ? stored.data : DEFAULT_PREFS;
}
export function writeNotifyPrefs(data: LocalData, computerId: string, prefs: NotifyPrefs) {
  return data.put(key(computerId), PrefsSchema.parse(prefs));
}
