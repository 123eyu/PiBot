import {
  SettingsRow,
  SettingsSection,
  TaskStatus,
  useRpc,
  useSettings,
  useTask,
} from "@pibot/renderer-kit";
import { TextField } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "./BackgroundLimit.module.css";

export function BackgroundLimit() {
  const { settings, update, t } = useSettings();
  const { peer } = useRpc();
  const task = useTask();
  const saved = settings?.backgroundCommandLimitMinutes ?? 120;
  const [minutes, setMinutes] = useState(String(saved));
  useEffect(() => setMinutes(String(saved)), [saved]);
  const value = Number(minutes);
  const valid = minutes.trim() !== "" && Number.isInteger(value) && value >= 30 && value <= 1440;
  return (
    <SettingsSection title={t("settings.backgroundCommands")}>
      <SettingsRow
        icon="clock"
        tone="amber"
        label={t("settings.backgroundLimit")}
        note={t("settings.backgroundLimitNote")}
      >
        {/* Maintainers 2026-11-13: settings take effect without a save button — on leaving the field
            or pressing Enter. */}
        <div className={styles.row}>
          <TextField
            label={t("settings.backgroundMinutes")}
            type="number"
            min={30}
            max={1440}
            step={1}
            value={minutes}
            disabled={!peer || task.busy}
            onChange={(event) => setMinutes(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={() => {
              if (peer && valid && value !== saved)
                void task.run(async () => {
                  await update({ backgroundCommandLimitMinutes: value });
                });
            }}
            error={!valid ? t("settings.backgroundLimitInvalid") : undefined}
          />
        </div>
      </SettingsRow>
      <TaskStatus task={task} />
    </SettingsSection>
  );
}
