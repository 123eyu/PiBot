import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Platform } from "react-native";
import { pibotAndroid } from "../../../modules/pibot-android/index.ts";
import type { MobileKey } from "../../i18n/messages.ts";
import { useMobileSelector, useRuntime } from "../../runtime/context.tsx";
import { nativeMedia, requestMediaRead } from "./media-native.ts";
import {
  DEFAULT_PHONE_DATA,
  type PhoneDataLogEntry,
  type PhoneDataPrefs,
  readPhoneDataLog,
  readPhoneDataPrefs,
  writePhoneDataPrefs,
} from "./prefs.ts";
import { nativeReadPages } from "./read-pages-native.ts";
import { nativeSms, requestSmsRead } from "./sms-native.ts";

type SmsCaps = Awaited<ReturnType<NonNullable<typeof nativeSms>["capabilities"]>>;
type ReadPageAccess = Record<"calls" | "notifications", "granted" | "denied" | "unsupported">;
const NO_READ_PAGES: ReadPageAccess = { calls: "unsupported", notifications: "unsupported" };
const readPageAccess = async (): Promise<ReadPageAccess> => {
  const native = pibotAndroid;
  if (!native || !nativeReadPages) return NO_READ_PAGES;
  const [calls, notifications] = await Promise.all(
    (["calls", "notifications"] as const).map((kind) =>
      native.readPagePermission(kind).catch(() => "unsupported" as const),
    ),
  );
  return { calls: calls ?? "unsupported", notifications: notifications ?? "unsupported" };
};
/** The phone-data page of the selected computer: switches, system access and the read log. */
export function usePhoneData() {
  const runtime = useRuntime(),
    mobile = useMobileSelector((s) => ({ devices: s.devices, selectedId: s.selectedId }));
  const computerId = mobile.selectedId;
  const [prefs, setPrefs] = useState<PhoneDataPrefs>(DEFAULT_PHONE_DATA);
  const [log, setLog] = useState<PhoneDataLogEntry[]>([]);
  const [media, setMedia] = useState<"granted" | "limited" | "denied">();
  const [sms, setSms] = useState<SmsCaps>();
  const [readPages, setReadPages] = useState<ReadPageAccess>(NO_READ_PAGES);
  const [error, setError] = useState<MobileKey>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!computerId) return;
    let live = true;
    void (async () => {
      const [nextPrefs, nextLog, nextMedia, nextSms, nextReadPages] = await Promise.all([
        readPhoneDataPrefs(runtime.storage.data, computerId),
        readPhoneDataLog(runtime.storage.data, computerId),
        nativeMedia.permission().catch(() => "denied" as const),
        nativeSms?.capabilities().catch(() => undefined),
        readPageAccess(),
      ]);
      if (!live) return;
      setPrefs(nextPrefs);
      setLog(nextLog);
      setMedia(nextMedia);
      setSms(nextSms);
      setReadPages(nextReadPages);
    })().catch(() => live && setError("phoneDataSaveFailed"));
    return () => {
      live = false;
    };
  }, [runtime, computerId]);
  // Back from system Settings (photo access, SMS permission, notification access) shows the new state.
  useFocusEffect(load);
  const change = async (patch: Partial<PhoneDataPrefs>, ask?: () => Promise<boolean>) => {
    if (!computerId || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // The system asks only when the owner turns a category on, never in advance.
      if (ask && !(await ask())) {
        setError(patch.smsFallback ? "phoneDataFallbackDenied" : "phoneDataDenied");
        return;
      }
      const next = { ...prefs, ...patch };
      await writePhoneDataPrefs(runtime.storage.data, computerId, next);
      setPrefs(next);
      runtime.phoneDataChanged(computerId);
    } catch {
      setError("phoneDataSaveFailed");
    } finally {
      setBusy(false);
      load();
    }
  };
  return {
    computer: mobile.devices.find((d) => d.id === computerId),
    platform: Platform.OS === "ios" ? ("ios" as const) : ("android" as const),
    prefs,
    log,
    media,
    sms,
    error,
    busy,
    readPages,
    setReadPage: (kind: "calls" | "notifications", on: boolean) =>
      change(
        { [kind]: on },
        on
          ? async () => {
              const native = pibotAndroid;
              if (!native || readPages[kind] === "unsupported") return false;
              if (kind === "calls") return (await native.requestCallHistory()).granted;
              // Notification access is a Settings page with no result; reads re-check the real state.
              if (readPages.notifications !== "granted") await native.openNotificationAccess();
              return true;
            }
          : undefined,
      ),
    setMedia: (on: boolean) => change({ media: on }, on ? requestMediaRead : undefined),
    setSmsCode: (on: boolean) => change({ smsCode: on }),
    setFallback: (on: boolean) => change({ smsFallback: on }, on ? requestSmsRead : undefined),
  };
}
