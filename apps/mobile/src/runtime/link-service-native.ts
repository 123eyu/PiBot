import { isTaskRegisteredAsync } from "expo-task-manager";
import { Platform } from "react-native";
import { pibotAndroid } from "../../modules/pibot-android/index.ts";
import { en, type MobileKey, zh } from "../i18n/messages.ts";
import type { LinkService } from "./runtime.ts";

/**
 * Android only: the remote-control foreground service of the local module.
 * Absent on iOS and in builds without the module; the background grace applies there.
 */
export function nativeLinkService(language: () => "zh" | "en"): LinkService | undefined {
  const android = Platform.OS === "android" ? pibotAndroid : null;
  if (!android) return undefined;
  return {
    onTick: (listener) => {
      const subscription = android.addListener("linkTick", listener);
      return () => subscription.remove();
    },
    wakeReady: () => isTaskRegisteredAsync("pibot-phone-wake-v1"),
    start: (text) => android.startLinkService(text.title, text.body, text.channel),
    update: (text) => android.updateLinkService(text.title, text.body, text.channel),
    stop: () => android.stopLinkService(),
    text(state, computerName) {
      const t = (key: MobileKey) => (language() === "zh" ? zh : en)[key];
      return {
        title: t(
          state === "online"
            ? "linkServiceOnline"
            : state === "wake"
              ? "linkServiceWake"
              : "linkServiceReconnecting",
        ),
        body: computerName,
        channel: t("linkServiceChannel"),
      };
    },
  };
}
