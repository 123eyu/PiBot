// Show and withdraw the Windows consent that was recorded in the YOLO confirmation.
import { SettingsLine, SettingsRow, useAction, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";

export function UnisolatedYoloRow({ disabled }: { disabled: boolean }) {
  const { t, settings, update, language } = useSettings();
  const action = useAction();
  if (window.pibot.platform !== "win32") return null;
  const consented = settings?.yoloUnisolatedCommands === true;
  const at = settings?.yoloUnisolatedCommandsAt;
  const date = at ? new Date(at).toLocaleDateString(language === "zh" ? "zh-CN" : "en") : null;
  const status = !settings
    ? t("common.loading")
    : consented
      ? date
        ? t("permissions.yoloWindowsConsentedAt", { date })
        : t("permissions.yoloWindowsConsented")
      : t("permissions.yoloWindowsNotConsented");
  return (
    <>
      <SettingsRow
        icon="shield"
        tone="orange"
        label={t("permissions.yoloUnisolated")}
        note={status}
      >
        {consented && (
          <Button
            variant="ghost"
            disabled={disabled || action.busy}
            onClick={() =>
              void action.run(
                () => update({ yoloUnisolatedCommands: false }),
                () => "permissions.yoloWindowsWithdrawFailed",
              )
            }
          >
            {t("permissions.yoloWindowsWithdraw")}
          </Button>
        )}
      </SettingsRow>
      {action.error && <SettingsLine tone="danger">{t(action.error)}</SettingsLine>}
    </>
  );
}
