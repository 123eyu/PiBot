import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { z } from "zod";
import type { Notice, NoticeRoute } from "./decide.ts";

/**
 * Native side of in-app notifications: Android channels, permission, presenting a notice, the
 * foreground display rule and taps. Local notices are created by this app only; nothing here
 * contacts a server.
 */
// The relay names the same channels for pushes (apps/relay/src/push/expo.ts).
export const CHANNELS = { approvals: "approvals", tasks: "tasks" } as const;
export type Permission = "granted" | "denied" | "undetermined";

export async function ensureChannels(names: { approvals: string; tasks: string }) {
  if (Platform.OS !== "android") return;
  // Re-setting an existing channel only updates its name (language switch); the person's own
  // importance and sound choices for it are kept by Android.
  await Promise.all([
    Notifications.setNotificationChannelAsync(CHANNELS.approvals, {
      name: names.approvals,
      importance: Notifications.AndroidImportance.HIGH,
    }),
    Notifications.setNotificationChannelAsync(CHANNELS.tasks, {
      name: names.tasks,
      importance: Notifications.AndroidImportance.DEFAULT,
    }),
  ]);
}
const permissionOf = (value: Notifications.NotificationPermissionsStatus): Permission =>
  value.granted || value.status === "granted"
    ? "granted"
    : value.status === "undetermined" && value.canAskAgain
      ? "undetermined"
      : "denied";
export async function readPermission() {
  return permissionOf(await Notifications.getPermissionsAsync());
}
/** Android 13+ shows POST_NOTIFICATIONS only once a channel exists: call ensureChannels first. */
export async function askPermission() {
  return permissionOf(
    await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    }),
  );
}

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const RouteSchema: z.ZodType<NoticeRoute> = z.discriminatedUnion("screen", [
  z.strictObject({ screen: z.literal("approval"), id }),
  z.strictObject({ screen: z.literal("browser"), botId: id, topic: id.optional() }),
  z.strictObject({ screen: z.literal("chat"), kind: z.enum(["bot", "group"]), id }),
  z.strictObject({ screen: z.literal("task"), kind: z.enum(["run", "routine"]), id }),
]);
const LocalDataSchema = z.strictObject({
  source: z.literal("pibot-local"),
  computerId: id,
  route: RouteSchema,
});
export type LocalData = z.infer<typeof LocalDataSchema>;
export function parseLocalData(data: unknown) {
  const parsed = LocalDataSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}
export async function presentNotice(
  notice: Notice,
  content: { title: string; body: string },
  computerId: string,
) {
  const data: LocalData = { source: "pibot-local", computerId, route: notice.route };
  const channelId =
    notice.kind === "approval" || notice.kind === "takeover" ? CHANNELS.approvals : CHANNELS.tasks;
  await Notifications.scheduleNotificationAsync({
    // Same identifier = the system replaces rather than stacks a repeat of one event.
    identifier: notice.id.replace(/[^A-Za-z0-9_-]/g, "_"),
    content: { title: content.title, body: content.body, data, sound: "default" },
    trigger: Platform.OS === "android" ? { channelId } : null,
  });
}

/**
 * Foreground display rule. Local notices were already decided (decide.ts) and always show. A push
 * that arrives while the app is open shows only if no local notice announced that event; the
 * callback records it so a later live event is not announced again.
 */
export function installNotificationHandler(remoteIsNew: (data: unknown) => Promise<boolean>) {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data: unknown = notification.request.content.data;
      const show =
        (data as { kind?: unknown } | null)?.kind === "wake"
          ? false
          : parseLocalData(data)
            ? true
            : await remoteIsNew(data).catch(() => true);
      return {
        shouldShowBanner: show,
        shouldShowList: show,
        shouldPlaySound: show,
        shouldSetBadge: false,
      };
    },
  });
  return () => Notifications.setNotificationHandler(null);
}
/** Taps, including the one that cold-started the app. Data is validated by the caller. */
export function listenForTaps(open: (data: unknown) => void) {
  const handle = (response: Notifications.NotificationResponse) => {
    // Handled once: a remount (e.g. pairing again) must not replay an old tap.
    Notifications.clearLastNotificationResponse();
    open(response.notification.request.content.data);
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handle);
  const previous = Notifications.getLastNotificationResponse();
  if (previous) handle(previous);
  return () => subscription.remove();
}
