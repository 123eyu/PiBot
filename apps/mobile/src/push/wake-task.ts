import { resolveLanguage } from "@pibot/i18n";
import { openPushRoute, unbase64 } from "@pibot/link";
import { getLocales } from "expo-localization";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { z } from "zod";
import { readPhoneDataPrefs } from "../features/phone-data/prefs.ts";
import { mobileOwner } from "../runtime/bootstrap.ts";
import { readDisplayPrefs } from "../theme/display.tsx";
import { readCredential } from "../transport/credential.ts";
import { readNotifyPrefs } from "./prefs.ts";

const TASK = "pibot-phone-wake-v1";
const Push = z.strictObject({ kind: z.literal("wake"), id: z.string().max(1024) });
const Ticket = z.strictObject({ id: z.string().uuid(), expires: z.string() });
/** Installed from the entry module, including when Expo launches JS without mounting React. */
export function installWakeTask() {
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data, error }) => {
    if (error || Platform.OS !== "android") return;
    let payload: unknown = data && "data" in data ? data.data : undefined;
    if (
      payload &&
      typeof payload === "object" &&
      "dataString" in payload &&
      typeof payload.dataString === "string"
    ) {
      try {
        payload = JSON.parse(payload.dataString);
      } catch {
        return;
      }
    }
    const parsed = Push.safeParse(payload);
    if (!parsed.success || !(await Notifications.getPermissionsAsync()).granted) return;
    // The phone's chosen language, as the app shows it; "system" falls back to the locale.
    const runtime = await mobileOwner.acquire(() =>
      resolveLanguage(readDisplayPrefs().language, getLocales()[0]?.languageTag ?? "en"),
    );
    try {
      for (const device of runtime.getSnapshot().devices) {
        const credential = await runtime.storage.secrets.get(device.id);
        if (!credential) continue;
        let key: Uint8Array | undefined;
        let ticket: z.infer<typeof Ticket>;
        try {
          key = unbase64(readCredential(credential).roomKey, 32);
          ticket = Ticket.parse(JSON.parse(openPushRoute(key, parsed.data.id)));
        } catch {
          continue;
        } finally {
          key?.fill(0);
        }
        const expires = Number(ticket.expires);
        // The computer stamps now + 30 s on its own clock; allow a minute of skew either way.
        if (
          !Number.isFinite(expires) ||
          expires < Date.now() - 60_000 ||
          expires > Date.now() + 90_000
        )
          return;
        const prefs = await readNotifyPrefs(runtime.storage.data, device.id);
        const phone = await readPhoneDataPrefs(runtime.storage.data, device.id);
        if (!prefs.enabled || !(phone.media || phone.smsCode || phone.calls || phone.notifications))
          return;
        const seenKey = `pref:${device.id}:wake`;
        if ((await runtime.storage.data.get(seenKey)) === ticket.id) return;
        await runtime.storage.data.put(seenKey, ticket.id);
        await runtime.wake(device.id, AbortSignal.timeout(240_000));
        return;
      }
    } finally {
      await mobileOwner.release();
    }
  });
  if (Platform.OS === "android")
    void Notifications.registerTaskAsync(TASK).catch(() => {
      // No background handler: desktop must not be given wake permission by token registration.
      console.warn(JSON.stringify({ module: "phone-wake", code: "registration_failed" }));
    });
}
