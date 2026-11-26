/** The shared Android update state and card used by the devices page and compatibility banner. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import { pibotAndroid } from "../../../modules/pibot-android/index.ts";
import { useText } from "../../runtime/context.tsx";
import { radius, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Button, ListCard } from "../../ui/controls.tsx";
import { Icon } from "../../ui/icons.tsx";
import {
  type AndroidUpdate,
  downloadAndroidUpdate,
  fetchAndroidUpdate,
  installAndroidUpdate,
  isNewerUpdate,
} from "./android-update.ts";

export type AndroidUpdatePhase =
  | "available"
  | "downloading"
  | "verify_failed"
  | "network_error"
  | "unknown_sources"
  | "installed";

export interface AndroidUpdateState {
  update?: AndroidUpdate;
  phase?: AndroidUpdatePhase;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
}

function isNetworkError(error: unknown) {
  return (
    error instanceof TypeError || (error instanceof Error && error.message.includes("network"))
  );
}

export function useAndroidUpdate() {
  const [state, setState] = useState<AndroidUpdateState>({
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
  });
  const controller = useRef<AbortController>();

  const check = useCallback(async () => {
    if (Platform.OS !== "android") return;
    try {
      const update = await fetchAndroidUpdate();
      if (isNewerUpdate(update))
        setState({
          update,
          phase: "available",
          progress: 0,
          downloadedBytes: 0,
          totalBytes: update.size,
        });
    } catch {
      // Update checks are best effort. The next app start or explicit action retries them.
    }
  }, []);

  useEffect(() => {
    void check();
    return () => controller.current?.abort();
  }, [check]);

  const start = useCallback(async () => {
    const update = state.update;
    if (!update) return;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setState((current) => ({ ...current, phase: "downloading", progress: 0, downloadedBytes: 0 }));
    try {
      const uri = await downloadAndroidUpdate(
        update,
        (progress) => {
          setState((current) => ({
            ...current,
            progress,
            downloadedBytes: Math.round(update.size * progress),
          }));
        },
        next.signal,
      );
      const result = await installAndroidUpdate(uri);
      if (result === "unknown_sources") {
        setState((current) => ({ ...current, phase: "unknown_sources" }));
        return;
      }
      setState((current) => ({
        ...current,
        phase: "installed",
        progress: 1,
        downloadedBytes: update.size,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        phase:
          error instanceof Error && error.message === "update_integrity_failed"
            ? "verify_failed"
            : isNetworkError(error)
              ? "network_error"
              : "available",
      }));
    }
  }, [state.update]);

  const cancel = useCallback(() => {
    controller.current?.abort();
    setState((current) => ({ ...current, phase: "available", progress: 0, downloadedBytes: 0 }));
  }, []);

  const settings = useCallback(async () => {
    await pibotAndroid?.openInstallSettings();
    if (state.update) void start();
  }, [start, state.update]);

  return { state, start, cancel, settings, check };
}

function megabytes(bytes: number) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function AndroidUpdateCard({ update }: { update: ReturnType<typeof useAndroidUpdate> }) {
  const t = useText();
  const colors = useColors();
  const { state, start, cancel, settings } = update;
  if (Platform.OS !== "android" || !state.update || !state.phase) return null;
  const failed = state.phase === "verify_failed";
  const downloading = state.phase === "downloading";
  const title =
    state.phase === "installed"
      ? t("updateInstallerOpened")
      : state.phase === "unknown_sources"
        ? t("updateUnknownSources")
        : state.phase === "network_error"
          ? t("updateNetworkError")
          : downloading
            ? t("updateDownloading", {
                version: state.update.version,
                percent: Math.round(state.progress * 100),
              })
            : failed
              ? t("updateVerifyFailed")
              : t("updateAvailable", { version: state.update.version });
  const hint =
    state.phase === "installed"
      ? t("updateInstallerOpenedHint")
      : state.phase === "unknown_sources"
        ? t("updateUnknownSourcesHint")
        : state.phase === "network_error"
          ? t("updateNetworkErrorHint")
          : downloading
            ? t("updateDownloadingHint", {
                done: megabytes(state.downloadedBytes),
                total: megabytes(state.update.size),
              })
            : failed
              ? t("updateVerifyFailedHint")
              : t("updateAvailableHint");
  const action = downloading
    ? t("updateCancel")
    : failed || state.phase === "network_error"
      ? t("updateRetry")
      : t("updateInstall");
  const onPress = downloading ? cancel : start;
  return (
    <ListCard style={{ marginTop: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16 }}>
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: radius.card,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.accent,
          }}
        >
          <Icon name="download" color={colors.onUser} size={25} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={[type.body, { color: colors.text, fontWeight: "600" }]}>{title}</Text>
          <Text style={[type.caption, { color: failed ? colors.danger : colors.text2 }]}>
            {hint}
          </Text>
          {downloading && (
            <View style={{ height: 6, marginTop: 4, borderRadius: 3, backgroundColor: colors.b2 }}>
              <View
                style={{
                  width: `${Math.round(state.progress * 100)}%`,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: colors.accent,
                }}
              />
            </View>
          )}
          {state.phase === "unknown_sources" && (
            <Button title={t("updateOpenSettings")} onPress={() => void settings()} />
          )}
        </View>
        {state.phase !== "unknown_sources" && state.phase !== "installed" && (
          <Button title={action} onPress={onPress} />
        )}
      </View>
    </ListCard>
  );
}
