import { type RoutineDraft, RoutineOutputFolderSchema } from "@pibot/protocol";
import { useSettings } from "@pibot/renderer-kit";
import { type IconName, IconTile, SegmentedControl, Switch, type Tone } from "@pibot/ui";
import { type ReactNode, useState } from "react";
import styles from "../shell/routines.module.css";

/** 运行方式: one row per option — coloured tile, name and note, control on the right. */
export function OptionRow({
  icon,
  tone,
  label,
  note,
  control,
  children,
}: {
  icon: IconName;
  tone: Tone;
  label: ReactNode;
  note?: ReactNode;
  control?: ReactNode;
  /** Full-width content under the row (a folder picker, the output folder fields). */
  children?: ReactNode;
}) {
  return (
    <div className={styles.optRow}>
      <IconTile icon={icon} tone={tone} size="lg" />
      <div className={styles.optText}>
        <strong>{label}</strong>
        {note && <small>{note}</small>}
      </div>
      {control}
      {children && <div className={styles.optBody}>{children}</div>}
    </div>
  );
}

/** Where each period's results go, relative to the task's own folder. */
function OutputOptions({
  draft,
  change,
}: {
  draft: RoutineDraft;
  change(patch: Partial<RoutineDraft>): void;
}) {
  const { t } = useSettings();
  const output = draft.output;
  const [folder, setFolder] = useState(output.folder ?? "");
  const invalid = folder.trim() !== "" && !RoutineOutputFolderSchema.safeParse(folder).success;
  return (
    <OptionRow
      icon="archive"
      tone="teal"
      label={t("routines.output")}
      note={t("routines.output.enabled")}
      control={
        <Switch
          label={t("routines.output.enabled")}
          checked={output.enabled}
          onCheckedChange={(enabled) => change({ output: { ...output, enabled } })}
        />
      }
    >
      {output.enabled && (
        <>
          <label className={styles.field}>
            {t("routines.output.folder")}
            <input
              value={folder}
              placeholder={t("routines.output.folderDefault", { name: draft.name || "…" })}
              aria-invalid={invalid}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setFolder(value);
                const parsed = RoutineOutputFolderSchema.safeParse(value);
                if (!value.trim()) change({ output: { ...output, folder: null } });
                else if (parsed.success) change({ output: { ...output, folder: parsed.data } });
              }}
            />
          </label>
          <div className={styles.field}>
            <span className={styles.label}>{t("routines.output.period")}</span>
            <div className={styles.chips}>
              {(["auto", "day", "week", "month"] as const).map((period) => (
                <button
                  key={period}
                  type="button"
                  className={styles.chip}
                  aria-pressed={output.period === period}
                  onClick={() => change({ output: { ...output, period } })}
                >
                  {t(`routines.output.period.${period}`)}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {invalid && (
        <p className={styles.error} role="alert">
          {t("routines.output.folderInvalid")}
        </p>
      )}
      <p className={styles.note}>{t("routines.output.note")}</p>
    </OptionRow>
  );
}
export function RoutineOptions({
  draft,
  change,
}: {
  draft: RoutineDraft;
  change(patch: Partial<RoutineDraft>): void;
}) {
  const { t } = useSettings();
  return (
    <>
      <OptionRow
        icon="refresh"
        tone="pink"
        label={t("routines.carry")}
        control={
          <Switch
            label={t("routines.carry")}
            checked={draft.carryLastResult}
            onCheckedChange={(carryLastResult) => change({ carryLastResult })}
          />
        }
      />
      <OutputOptions draft={draft} change={change} />
      <OptionRow
        icon="message"
        tone="violet"
        label={t("routines.notify")}
        control={
          <SegmentedControl
            className={styles.seg}
            label={t("routines.notify")}
            value={draft.notify}
            options={(["always", "on_attention", "never"] as const).map((v) => ({
              value: v,
              label: t(`routines.notify.${v}`),
            }))}
            onValueChange={(notify) => change({ notify })}
          />
        }
      />
      <OptionRow
        icon="clock"
        tone="orange"
        label={t("routines.duration")}
        control={
          <input
            required
            type="number"
            className={styles.small}
            aria-label={t("routines.duration")}
            min={5}
            max={120}
            value={draft.maxDurationMin}
            onChange={(e) => change({ maxDurationMin: e.currentTarget.valueAsNumber })}
          />
        }
      />
      <OptionRow icon="moon" tone="amber" label={t("routines.missed")}>
        <div className={styles.chips}>
          {(["global", "catchup", "skip", "ask"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={styles.chip}
              aria-pressed={(draft.missedPolicy ?? "global") === v}
              onClick={() => change({ missedPolicy: v === "global" ? null : v })}
            >
              {t(`routines.missed.${v}`)}
            </button>
          ))}
        </div>
      </OptionRow>
      <OptionRow
        icon="power"
        tone="green"
        label={t("routines.enabled")}
        control={
          <Switch
            label={t("routines.enabled")}
            checked={draft.enabled}
            onCheckedChange={(enabled) => change({ enabled })}
          />
        }
      />
    </>
  );
}
