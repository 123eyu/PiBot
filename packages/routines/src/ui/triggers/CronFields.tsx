import type { RoutineDraft } from "@pibot/protocol";
import { AppSelect, DateField, useRpc, useSettings } from "@pibot/renderer-kit";
import { cronFieldIssue } from "@pibot/routines-contract";
import { Switch } from "@pibot/ui";
import styles from "../shell/routines.module.css";

type Trigger = RoutineDraft["triggers"][number];

import { useEffect, useMemo, useState } from "react";
import { type CronChoice, cronChoice, cronText, presetCron, systemTimezone } from "./cron.ts";
import { timezoneOptions } from "./timezones.ts";
export function CronFields({
  value,
  change,
  disabled = false,
}: {
  value: Extract<Trigger, { kind: "cron" }>;
  change(value: Trigger): void;
  disabled?: boolean;
}) {
  const { t, language } = useSettings();
  const timezone = systemTimezone();
  const { peer } = useRpc();
  const [validation, setValidation] = useState<{
    key: string;
    issue: import("@pibot/protocol").MethodResults["routines.validateCron"]["issue"];
    minimum: number;
    failed?: boolean;
  }>();
  const validationKey = `${value.expr}:${value.timezone}`;
  useEffect(() => {
    if (!peer || cronFieldIssue(value.expr)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void peer
        .call(
          "routines.validateCron",
          { expr: value.expr, timezone: value.timezone },
          { signal: controller.signal, timeoutMs: 15000 },
        )
        .then(
          (result) => {
            if (!controller.signal.aborted)
              setValidation({
                key: validationKey,
                issue: result.issue,
                minimum: result.minimumMinutes,
              });
          },
          () => {
            if (!controller.signal.aborted)
              setValidation({ key: validationKey, issue: null, minimum: 5, failed: true });
          },
        );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [peer, value.expr, value.timezone, validationKey]);
  const options = useMemo(
    () => timezoneOptions(timezone, value.timezone),
    [timezone, value.timezone],
  );
  const [choice, setChoice] = useState<CronChoice>(() => cronChoice(value.expr));
  const issue =
    cronFieldIssue(value.expr) ??
    (validation?.key === validationKey ? validation.issue : undefined);
  const update = (patch: Partial<CronChoice>) => {
    const next = { ...choice, ...patch };
    setChoice(next);
    change({ ...value, expr: presetCron(next) });
  };
  return (
    <>
      <div className={styles.field}>
        <span className={styles.label}>{t("routines.cron")}</span>
        <div className={styles.chips}>
          {(["daily", "weekdays", "weekly", "monthly", "hourly", "advanced"] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={styles.chip}
              aria-pressed={choice.preset === p}
              onClick={() => update({ preset: p, expr: value.expr })}
            >
              {t(`routines.preset.${p}`)}
            </button>
          ))}
        </div>
      </div>
      {choice.preset === "weekly" && (
        <div className={styles.chips}>
          {([1, 2, 3, 4, 5, 6, 0] as const).map((day) => {
            const on = choice.days.includes(day);
            return (
              <button
                key={day}
                type="button"
                className={`${styles.chip} ${styles.day}`}
                aria-pressed={on}
                aria-label={t(`routines.day.${day}`)}
                onClick={() =>
                  update({
                    days: on ? choice.days.filter((d) => d !== day) : [...choice.days, day],
                  })
                }
              >
                {t(`routines.dayShort.${day}`)}
              </button>
            );
          })}
        </div>
      )}
      {choice.preset === "advanced" ? (
        <label className={styles.field}>
          {t("routines.preset.advanced")}
          <input
            required
            aria-invalid={!!issue}
            maxLength={200}
            value={value.expr}
            onChange={(e) => update({ expr: e.currentTarget.value })}
          />
        </label>
      ) : choice.preset === "hourly" ? (
        <>
          <div className={styles.row}>
            {(["every", "start", "end"] as const).map((key) => (
              <label key={key} className={styles.field}>
                {t(
                  key === "every"
                    ? "routines.everyHours"
                    : key === "start"
                      ? "routines.startHour"
                      : "routines.endHour",
                )}
                <input
                  type="number"
                  className={styles.small}
                  required
                  min={key === "every" ? 1 : 0}
                  max={23}
                  value={choice[key]}
                  onChange={(e) => update({ [key]: e.currentTarget.valueAsNumber })}
                />
              </label>
            ))}
          </div>
          <div className={styles.switchRow}>
            <span>{t("routines.onlyWeekdays")}</span>
            <Switch
              label={t("routines.onlyWeekdays")}
              checked={choice.weekdays}
              onCheckedChange={(weekdays) => update({ weekdays })}
            />
          </div>
        </>
      ) : (
        <div className={styles.row}>
          <label className={styles.field}>
            {t("routines.time")}
            <DateField
              mode="time"
              label={t("routines.time")}
              tone="orange"
              appearance="tinted"
              required
              value={choice.time}
              onValueChange={(time) => update({ time })}
            />
          </label>
          {choice.preset === "monthly" && (
            <label className={`${styles.field} ${styles.grow}`}>
              {t("routines.dayOfMonth")}
              <input
                required
                type="number"
                className={styles.small}
                min={1}
                max={31}
                value={choice.day}
                onChange={(e) => update({ day: e.currentTarget.valueAsNumber })}
              />
            </label>
          )}
        </div>
      )}
      <AppSelect
        label={t("routines.timezone")}
        value={value.timezone}
        options={options}
        disabled={disabled}
        change={(timezone) => {
          if (!disabled) change({ ...value, timezone });
        }}
      />
      <p className={styles.note}>{t("routines.timezoneNote")}</p>
      {issue ? (
        <p role="alert" className={styles.error}>
          {t(
            `routines.cronError.${choice.preset === "weekly" && !choice.days.length ? "weekly" : issue}`,
          )}
        </p>
      ) : validation?.key !== validationKey ? (
        <p className={styles.note} role="status">
          {t("common.loading")}
        </p>
      ) : validation.failed ? (
        <p className={styles.error} role="alert">
          {t("routines.unavailable")}
        </p>
      ) : (
        <p className={styles.note}>{cronText(value.expr, value.timezone, language)}</p>
      )}
      <p className={styles.note}>{t("routines.cronNote")}</p>
    </>
  );
}
