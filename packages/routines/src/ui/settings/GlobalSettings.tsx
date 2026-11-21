import type { RoutineSettings } from "@pibot/protocol";
import {
  AppSelect,
  layoutStyles,
  type Peer,
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useRpc,
  useSettings,
} from "@pibot/renderer-kit";
import { Button, Switch } from "@pibot/ui";
import { useCallback } from "react";
import { useRoutinePower, useRoutinesPorts } from "../shell/ports.tsx";
import { useRemote, useRoutineAction } from "../shell/remote.ts";

function lidKey(platform: string) {
  return platform === "darwin"
    ? "routines.lid.darwin"
    : platform === "win32"
      ? "routines.lid.win32"
      : "routines.lid.linux";
}

export function GlobalRoutineSettings() {
  const { t } = useSettings();
  const { peer } = useRpc();
  const power = useRoutinePower();
  const load = useCallback((peer: Peer) => peer.call("routines.settings.get", undefined), []);
  const remote = useRemote(load);
  const action = useRoutineAction();
  const disabled = action.disabled || remote.loading;
  const save = (patch: Partial<RoutineSettings>) => {
    if (peer)
      void action
        .run(() => peer.call("routines.settings.set", patch))
        .then((result) => {
          if (result) remote.refresh();
        });
  };
  const lid = t(lidKey(useRoutinesPorts().platform));
  return (
    <SettingsSection title={t("routines.globalSettings")}>
      {remote.loading && <SettingsLine role="status">{t("common.loading")}</SettingsLine>}
      {remote.value && (
        <>
          <SettingsRow icon="moon" tone="violet" label={t("routines.missed")}>
            <div className={layoutStyles.select}>
              <AppSelect
                hideLabel
                label={t("routines.missed")}
                disabled={disabled}
                value={remote.value.missedPolicy}
                options={(["catchup", "skip", "ask"] as const).map((value) => ({
                  value,
                  label: t(`routines.missed.${value}`),
                }))}
                change={(value) => save({ missedPolicy: value as RoutineSettings["missedPolicy"] })}
              />
            </div>
          </SettingsRow>
          <SettingsRow icon="bolt" tone="amber" label={t("routines.keepAwake")}>
            <div className={layoutStyles.select}>
              <AppSelect
                hideLabel
                label={t("routines.keepAwake")}
                disabled={disabled}
                value={remote.value.keepAwake}
                options={(["on_ac", "always", "never"] as const).map((value) => ({
                  value,
                  label: t(`routines.keepAwake.${value}`),
                }))}
                change={(value) => save({ keepAwake: value as RoutineSettings["keepAwake"] })}
              />
            </div>
          </SettingsRow>
          <SettingsRow icon="pause" tone="orange" label={t("routines.awayRule")}>
            <Switch
              label={t("routines.awayRule")}
              disabled={disabled}
              checked={remote.value.pauseWhenAway}
              onCheckedChange={(pauseWhenAway) => save({ pauseWhenAway })}
            />
          </SettingsRow>
        </>
      )}
      {/* Power state and the lid caveat as one grey line inside the card. */}
      <SettingsLine role="status">
        {power
          ? t("routines.powerLine", { supply: t(`routines.power.${power.supply}`), lid })
          : lid}
      </SettingsLine>
      {(remote.error || action.error) && (
        <SettingsLine
          role="alert"
          tone="danger"
          action={
            <Button
              variant="ghost"
              disabled={action.busy || remote.loading || !peer}
              onClick={remote.refresh}
            >
              {t("common.retry")}
            </Button>
          }
        >
          {t(remote.error ?? action.error ?? "routines.failed")}
        </SettingsLine>
      )}
    </SettingsSection>
  );
}
