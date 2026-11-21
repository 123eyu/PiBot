import { SettingsLine, SettingsRow, useRpc, useSettings, useTask } from "@pibot/renderer-kit";
import { SegmentedControl } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { backgroundPreferencesEditable } from "../../../shared/background-presentation.ts";
import { requirePeer } from "../settings/operations.ts";
import { BackgroundSettingsState, initialBackgroundSnapshot } from "./background-settings-state.ts";

type Choice = "off" | "window" | "background";

/**
 * One 「登录这台电脑时」 choice over the two existing settings. Opening the
 * window starts the service anyway, so `openAtLogin` decides "window" whatever the background
 * item says; only with the window off does the background item mean "background only". Picking
 * "window" leaves the background item as it is (both on starts the same way at sign-in), so no
 * extra write can fail on the way. Neither setting's storage or protocol changes.
 */
export function LoginStartRow({ disabled: outerDisabled }: { disabled: boolean }) {
  const { peer } = useRpc();
  const { t, settings, update } = useSettings();
  const task = useTask();
  const [snapshot, setSnapshot] = useState(initialBackgroundSnapshot);
  const controller = useRef<BackgroundSettingsState | undefined>(undefined);
  // Static rendering (tests) has no window; the choice then shows only the window setting.
  const bridge = typeof window === "undefined" ? undefined : window.pibot?.background;
  const available =
    !!bridge &&
    typeof bridge.serviceState === "function" &&
    typeof bridge.preferences === "function";
  useEffect(() => {
    if (!available) return;
    const current = new BackgroundSettingsState(bridge);
    controller.current = current;
    const off = current.subscribe(setSnapshot);
    void current.refresh();
    return () => {
      off();
      current.dispose();
      if (controller.current === current) controller.current = undefined;
    };
  }, [bridge, available]);
  const { state, known, saving, stopping, stopRequested } = snapshot;
  const background = known ? (state?.preferences.startAtLogin ?? false) : false;
  const backgroundEditable =
    known &&
    !!state &&
    backgroundPreferencesEditable(state) &&
    !saving &&
    !stopping &&
    !stopRequested &&
    state.management.available;
  const open = settings?.openAtLogin ?? false;
  const value: Choice = open ? "window" : background ? "background" : "off";
  // Turning the background item off needs it editable; otherwise "off" would silently stay on.
  const locked =
    outerDisabled || task.busy || saving || !settings || (background && !backgroundEditable);
  const choose = (next: Choice) =>
    void task.run(async () => {
      requirePeer(peer);
      if (next === "background") {
        // The background item first: if it fails, the window setting is still what it was.
        if (!background) await controller.current?.save({ startAtLogin: true });
        if (open) await update({ openAtLogin: false });
        return;
      }
      if (next === "window") {
        if (!open) await update({ openAtLogin: true });
        return;
      }
      if (open) await update({ openAtLogin: false });
      if (background) await controller.current?.save({ startAtLogin: false });
    });
  const reason = state?.management.reason;
  // Only a platform limit is worth saying; "not packaged" is a developer build detail.
  const reasonKey =
    known && state && !state.management.available && reason && reason !== "unpackaged"
      ? reason === "data_dir"
        ? "background.reason.data_dir"
        : reason !== "available"
          ? (`background.reason.${reason}` as const)
          : undefined
      : undefined;
  return (
    <>
      <SettingsRow
        icon="power"
        tone="green"
        label={t("startup.loginStart")}
        note={t(`startup.loginStart.${value}Note`)}
        info={value === "background" ? t("background.loginNote") : undefined}
      >
        <SegmentedControl<Choice>
          label={t("startup.loginStart")}
          disabled={locked}
          value={value}
          options={[
            { value: "off", label: t("startup.loginStart.off") },
            { value: "window", label: t("startup.loginStart.window") },
            {
              value: "background",
              label: t("startup.loginStart.background"),
              disabled: !backgroundEditable && !background,
              title: reasonKey ? t(reasonKey) : undefined,
            },
          ]}
          onValueChange={choose}
        />
      </SettingsRow>
      {reasonKey && <SettingsLine>{t(reasonKey)}</SettingsLine>}
      {snapshot.failed && available && (
        <SettingsLine role="alert" tone="danger" dot="danger">
          {t(snapshot.uncertain ? "background.uncertain" : "background.failed")}
        </SettingsLine>
      )}
      {task.error && (
        <SettingsLine role="alert" tone="danger" dot="danger">
          {task.error}
        </SettingsLine>
      )}
    </>
  );
}
