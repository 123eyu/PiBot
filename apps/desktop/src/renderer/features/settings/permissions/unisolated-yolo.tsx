import { layoutStyles, SettingsRow, useSettings } from "@pibot/renderer-kit";
import { Button, Switch } from "@pibot/ui";
import { useState } from "react";

/**
 * Windows only: commands there run without a sandbox, so YOLO approves them
 * only after the user turns this on and confirms the risk. Other platforms never run commands
 * unisolated, so the row is not shown there.
 */
export function UnisolatedYoloRow({ disabled }: { disabled: boolean }) {
  const { t, settings, update } = useSettings();
  const [confirming, setConfirming] = useState(false);
  if (window.pibot.platform !== "win32" || !settings) return null;
  const on = settings.yoloUnisolatedCommands === true;
  return (
    <>
      <SettingsRow
        icon="warning"
        tone="red"
        label={t("permissions.yoloUnisolated")}
        note={t("permissions.short.yoloUnisolated")}
        info={t("permissions.yoloUnisolatedNote")}
      >
        <Switch
          label={t("permissions.yoloUnisolated")}
          checked={on}
          disabled={disabled || confirming}
          onCheckedChange={(next) => {
            if (next) setConfirming(true);
            else void update({ yoloUnisolatedCommands: false });
          }}
        />
      </SettingsRow>
      {confirming && (
        <div
          role="alertdialog"
          aria-label={t("permissions.yoloUnisolated")}
          className={layoutStyles.banner}
          data-tone="danger"
        >
          <span>{t("permissions.yoloUnisolatedConfirm")}</span>
          <Button
            variant="ghost"
            className={layoutStyles.small}
            disabled={disabled}
            onClick={() => setConfirming(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            className={layoutStyles.small}
            disabled={disabled}
            onClick={() => {
              setConfirming(false);
              void update({ yoloUnisolatedCommands: true });
            }}
          >
            {t("permissions.yoloUnisolatedEnable")}
          </Button>
        </div>
      )}
    </>
  );
}
