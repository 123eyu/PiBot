import type { EventPayloads } from "@pibot/protocol";
import { useGlobalSearchParams, usePathname, useRootNavigationState, useRouter } from "expo-router";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useConversations } from "../features/conversations/conversations-context.tsx";
import { useLanguage, useLinkState, useRuntime, useText } from "../runtime/context.tsx";
import type { MobileRuntime } from "../runtime/runtime.ts";
import { useAction } from "../runtime/use-action.ts";
import { openPushEvent } from "../transport/push-route.ts";
import { decide, type Notice, noticeText, toNotice } from "./decide.ts";
import {
  askPermission,
  ensureChannels,
  installNotificationHandler,
  listenForTaps,
  type Permission,
  parseLocalData,
  presentNotice,
  readPermission,
} from "./local.ts";
import { expoPushToken, pushAvailability } from "./notifications.ts";
import { pushRoute, routeHref, screenOf } from "./open-route.ts";
import { DEFAULT_PREFS, type NotifyPrefs, readNotifyPrefs, writeNotifyPrefs } from "./prefs.ts";
import { SeenEvents } from "./seen.ts";

/** A push from any paired computer: each has its own room key, so at most one opens it. */
async function openAnyPush(runtime: MobileRuntime, data: unknown) {
  for (const computer of runtime.getSnapshot().devices) {
    const credential = await runtime.storage.secrets.get(computer.id);
    const event = credential ? openPushEvent(credential, data) : undefined;
    if (event) return { computerId: computer.id, event };
  }
  return undefined;
}
function useNotificationsState() {
  const runtime = useRuntime(),
    mobile = useLinkState(),
    conversations = useConversations(),
    router = useRouter(),
    navigation = useRootNavigationState(),
    pathname = usePathname(),
    params = useGlobalSearchParams(),
    language = useLanguage(),
    t = useText();
  const [prefs, setPrefs] = useState<NotifyPrefs & { computerId: string }>();
  const [permission, setPermission] = useState<Permission>();
  const action = useAction(mobile.selectedId);
  const availability = pushAvailability();
  const seen = useRef(new SeenEvents()).current;
  const asked = useRef(false);
  const synced = useRef<{ peer: unknown; want: boolean }>(undefined);
  // Event handlers read the latest values without resubscribing on every render.
  const live = useRef({ prefs, screen: screenOf(pathname, params), conversations, t });
  live.current = { prefs, screen: screenOf(pathname, params), conversations, t };
  const channels = () =>
    ensureChannels({ approvals: t("channelApprovals"), tasks: t("channelTasks") });

  useEffect(() => {
    const id = mobile.selectedId;
    setPrefs(undefined);
    if (!id) return;
    let on = true;
    void readNotifyPrefs(runtime.storage.data, id)
      .catch(() => DEFAULT_PREFS)
      .then((value) => {
        if (on) setPrefs({ ...value, computerId: id });
      });
    return () => {
      on = false;
    };
  }, [runtime, mobile.selectedId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: channel names follow the language only.
  useEffect(() => {
    // Android channels carry the names shown in system settings; no permission prompt here.
    void channels().catch(() => undefined);
    const check = () =>
      void readPermission()
        .then(setPermission)
        .catch(() => setPermission("denied"));
    check();
    // The person may change the permission in system settings while the app is away.
    const sub = AppState.addEventListener("change", (state) => state === "active" && check());
    return () => sub.remove();
  }, [language]);
  // Ask as soon as a paired computer has notifications on and the app is on screen. Waiting for
  // the first in-app notice meant a phone could never register its push token, so nothing
  // arrived once the app was closed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once per run; channels follow t.
  useEffect(() => {
    if (!prefs?.enabled || permission !== "undetermined" || asked.current) return;
    if (AppState.currentState !== "active") return;
    asked.current = true;
    void channels()
      .then(askPermission)
      .then(setPermission)
      .catch(() => setPermission("denied"));
  }, [prefs?.enabled, permission]);
  useEffect(
    () =>
      installNotificationHandler(async (data) => {
        const found = await openAnyPush(runtime, data);
        if (!found) return true;
        if (seen.has(found.event.eventId)) return false;
        seen.add(found.event.eventId);
        return true;
      }),
    [runtime, seen],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: one subscription per connection and computer.
  useEffect(() => {
    const peer = mobile.peer,
      computerId = prefs?.computerId;
    if (!peer || !computerId) return;
    const show = async (notice: Notice) => {
      let granted = await readPermission();
      // First need: ask once per app run, and only on screen (a background prompt cannot show).
      if (granted === "undetermined" && AppState.currentState === "active" && !asked.current) {
        asked.current = true;
        await channels();
        granted = await askPermission();
      }
      setPermission(granted);
      if (granted !== "granted") return;
      const { conversations: names, t: text } = live.current;
      const content = noticeText(
        notice,
        {
          bot: (id) => names.bots.get(id)?.name,
          group: (id) => names.find("group", id)?.name,
        },
        text,
      );
      await presentNotice(notice, content, computerId);
    };
    const handle = (notice: Notice | undefined) => {
      const current = live.current.prefs;
      if (!notice || !current || current.computerId !== computerId) return;
      const foreground = AppState.currentState === "active";
      const decision = decide(notice, {
        enabled: current.enabled,
        linked: runtime.getSnapshot().status === "online",
        foreground,
        screen: foreground ? live.current.screen : undefined,
        pushRegistered: current.push,
        seen: (id) => seen.has(id),
      });
      if (decision !== "show") return;
      seen.add(notice.id);
      // A missed hint is harmless: the approval, reply or task is in the app either way.
      void show(notice).catch(() => undefined);
    };
    const on =
      <K extends Parameters<typeof toNotice>[0]>(method: K) =>
      (payload: EventPayloads[K]) =>
        handle(toNotice(method, payload));
    const off = [
      peer.on("approval.requested", on("approval.requested")),
      peer.on("chat.done", on("chat.done")),
      peer.on("chat.error", on("chat.error")),
      peer.on("execution.task.changed", on("execution.task.changed")),
      peer.on("routine.run", on("routine.run")),
    ];
    return () => {
      for (const fn of off) fn();
    };
  }, [mobile.peer, prefs?.computerId]);
  // Remote push follows the switch: the computer holds this phone's token only while
  // notifications are on, the build has a project id and the system permission is granted.
  useEffect(() => {
    const peer = mobile.peer;
    if (mobile.status !== "online" || !peer || !prefs || prefs.computerId !== mobile.selectedId)
      return;
    const want = prefs.enabled && availability === "ready" && permission === "granted";
    if ((!want && !prefs.push) || (synced.current?.peer === peer && synced.current.want === want))
      return;
    synced.current = { peer, want };
    const controller = new AbortController();
    const { computerId, enabled } = prefs;
    void (async () => {
      const token = want ? await expoPushToken(controller.signal) : null;
      await runtime.registerPush(token, language, computerId);
      controller.signal.throwIfAborted();
      const next = { enabled, push: want };
      await writeNotifyPrefs(runtime.storage.data, computerId, next);
      setPrefs((value) => (value?.computerId === computerId ? { ...value, push: want } : value));
    })().catch(() => {
      // The next connection tries again; the settings row keeps saying push is not on.
      if (synced.current?.peer === peer) synced.current = undefined;
    });
    return () => controller.abort();
  }, [
    runtime,
    mobile.status,
    mobile.peer,
    mobile.selectedId,
    prefs,
    permission,
    availability,
    language,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: taps are handled once the navigator exists.
  useEffect(() => {
    if (!navigation?.key) return;
    // A list tab opens in the tabs already at the bottom: a push stacked a second set of tabs,
    // so back from them led to the first set instead of leaving the app.
    const open = (href: string) =>
      href.startsWith("/(tabs)/") ? router.dismissTo(href) : router.push(href);
    return listenForTaps((data) => {
      void (async () => {
        const local = parseLocalData(data);
        const pushed = local ? undefined : await openAnyPush(runtime, data);
        if (pushed) seen.add(pushed.event.eventId);
        const computerId = local?.computerId ?? pushed?.computerId;
        const route = local?.route ?? (pushed && pushRoute(pushed.event));
        const snapshot = runtime.getSnapshot();
        if (!computerId || !route || !snapshot.devices.some((d) => d.id === computerId)) {
          // An unreadable push still says what it was about; its list is the safe place to land.
          const kind = (data as { kind?: unknown } | null)?.kind;
          open(kind === "approval" ? "/(tabs)/approvals" : "/(tabs)/tasks");
          return;
        }
        if (computerId !== snapshot.selectedId) await runtime.select(computerId);
        runtime.refresh();
        open(await routeHref(runtime, computerId, route));
      })().catch(() => undefined); // The app stays where it is; nothing was sent anywhere.
    });
  }, [navigation?.key, runtime]);

  return {
    enabled: prefs?.enabled ?? DEFAULT_PREFS.enabled,
    ready: !!prefs,
    permission,
    availability,
    pushOn: !!prefs?.push,
    action,
    setEnabled: (enabled: boolean) =>
      action.run(async () => {
        if (!prefs) return;
        const next = { enabled, push: prefs.push };
        await writeNotifyPrefs(runtime.storage.data, prefs.computerId, next);
        setPrefs({ ...next, computerId: prefs.computerId });
        if (!enabled) return;
        await channels();
        let granted = await readPermission();
        if (granted === "undetermined") granted = await askPermission();
        setPermission(granted);
        if (granted !== "granted") throw new Error("notify_denied");
      }),
  };
}
type NotificationsState = ReturnType<typeof useNotificationsState>;
const Context = createContext<NotificationsState | null>(null);
/** In-app notifications and push registration for the selected computer. */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useNotificationsState()}>{children}</Context.Provider>;
}
export function useNotifications() {
  const value = useContext(Context);
  if (!value) throw new Error("notifications_unavailable");
  return value;
}
