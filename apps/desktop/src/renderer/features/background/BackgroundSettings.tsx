import { SettingsLine, SettingsRow, SettingsSection, useSettings } from "@pibot/renderer-kit";
import { SegmentedControl } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { backgroundPreferencesEditable } from "../../../shared/background-presentation.ts";
import { BackgroundSettingsState, initialBackgroundSnapshot } from "./background-settings-state.ts";

/**
 * Independent background scheduling (after quitting the desktop): plain choices, no
 * internal state words. The tray switch lives only in Settings · General, and the helper's tray
 * follows it (see shouldShowOwnerTray). The sign-in start moved into General's one
 * 「登录这台电脑时」 choice (LoginStartRow).
 */
export function BackgroundSettings() {
  const { t } = useSettings();
  const [snapshot, setSnapshot] = useState(initialBackgroundSnapshot);
  const controller = useRef<BackgroundSettingsState | undefined>(undefined);
  const bridge = window.pibot?.background;
  const available =
    !!bridge &&
    typeof bridge.serviceState === "function" &&
    typeof bridge.preferences === "function" &&
    typeof bridge.stopService === "function";
  useEffect(() => {
    if (!available) {
      setSnapshot({ ...initialBackgroundSnapshot, failed: true });
      return;
    }
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
  const disabled =
    !known ||
    !state ||
    !backgroundPreferencesEditable(state) ||
    saving ||
    stopping ||
    stopRequested;
  const supported = window.pibot.platform === "darwin" || window.pibot.platform === "win32";
  const exit = state?.preferences.exitBehavior ?? "stop";
  return (
    <SettingsSection title={t("background.title")}>
      <SettingsRow
        icon="power"
        tone="green"
        label={t("background.exit")}
        note={supported ? t("background.note") : t("background.windowsUnavailable")}
      >
        <SegmentedControl<"stop" | "continue">
          label={t("background.exit")}
          disabled={disabled}
          value={exit}
          options={[
            { value: "stop", label: t("background.independent.stop") },
            {
              value: "continue",
              label: t("background.independent.continue"),
              disabled: !supported,
            },
          ]}
          // Start at sign-in is independent of the exit choice.
          onValueChange={(value) => void controller.current?.save({ exitBehavior: value })}
        />
      </SettingsRow>
      {saving && <SettingsLine role="status">{t("background.saving")}</SettingsLine>}
      {snapshot.failed && (
        <SettingsLine role="alert" tone="danger" dot="danger">
          {t(snapshot.uncertain ? "background.uncertain" : "background.failed")}
        </SettingsLine>
      )}
    </SettingsSection>
  );
}
