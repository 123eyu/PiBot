import Constants from "expo-constants";
import { isDevice } from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { pibotAndroid } from "../../modules/pibot-android/index.ts";
import { nativeWait } from "../runtime/native-wait.ts";

/**
 * Expo remote push. Only ready when the build carries an EAS project id
 * (app.config.ts, docs/push-setup.md) and runs on a real device; otherwise the phone skips
 * registration and relies on in-app notifications while linked. Android also needs the Firebase
 * config (GOOGLE_SERVICES_JSON at build time).
 */
export type PushAvailability = "ready" | "unconfigured" | "unsupported" | "apple_account";
function projectId() {
  const value: unknown = Constants.expoConfig?.extra?.eas?.projectId;
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}
export function pushAvailability(): PushAvailability {
  // Android tokens come from Firebase: a build without google-services.json has none to ask for.
  const fcm = Constants.expoConfig?.extra?.fcm === true;
  if (!projectId() || (Platform.OS === "android" && !fcm)) return "unconfigured";
  // A free Apple ID cannot sign the push entitlement, so such a build has no token to ask for.
  if (Platform.OS === "ios" && Constants.expoConfig?.extra?.apns !== true) return "apple_account";
  return isDevice ? "ready" : "unsupported";
}
/** Needs notification permission already granted (local.ts asks for it). */
export async function expoPushToken(signal: AbortSignal) {
  if (Platform.OS === "android" && pibotAndroid && !(await pibotAndroid.googleServicesAvailable()))
    throw new Error("push_unavailable");
  const id = projectId();
  if (!id || !isDevice) throw new Error("push_unavailable");
  const token = await nativeWait(
    Notifications.getExpoPushTokenAsync({ projectId: id }),
    signal,
    20_000,
  );
  signal.throwIfAborted();
  return token.data;
}
