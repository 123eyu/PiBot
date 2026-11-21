import type { CalendarTrigger, MethodResults } from "@pibot/protocol";
import { useRpc, useSettings } from "@pibot/renderer-kit";
import { Button, SegmentedControl } from "@pibot/ui";
import { useState } from "react";
import { useRoutineAction } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";
import type { TriggerSources } from "./ConnectionFields.tsx";

type Calendars = MethodResults["routines.calendarList"]["items"];

export function CalendarFields({
  value,
  change,
  sources,
  botId,
  disabled,
}: {
  value: CalendarTrigger;
  change(next: CalendarTrigger): void;
  sources: TriggerSources | undefined;
  botId: string;
  disabled?: boolean;
}) {
  const { t } = useSettings();
  const { peer } = useRpc();
  const action = useRoutineAction();
  // Listing calendars reads the calendar (audited), so it happens only when asked.
  const [calendars, setCalendars] = useState<Calendars>();
  const connected = sources?.calendars.some((row) => row.connectorId === value.connectorId);
  const toggle = (id: string, on: boolean) =>
    change({
      ...value,
      calendarIds: on
        ? [...value.calendarIds.filter((item) => item !== id), id]
        : value.calendarIds.filter((item) => item !== id),
    });
  return (
    <>
      <div className={styles.row}>
        <div className={styles.field}>
          <span className={styles.label}>{t("routines.calendar.when")}</span>
          <SegmentedControl
            className={styles.seg}
            label={t("routines.calendar.when")}
            disabled={disabled}
            value={value.event}
            options={[
              { value: "before_start", label: t("routines.calendar.event.before_start") },
              { value: "new_event", label: t("routines.calendar.event.new_event") },
            ]}
            onValueChange={(event) => change({ ...value, event })}
          />
        </div>
        {value.event === "before_start" && (
          <label className={styles.field}>
            {t("routines.calendar.minutesBefore")}
            <input
              type="number"
              className={styles.small}
              min={1}
              max={1440}
              step={1}
              value={value.minutesBefore}
              disabled={disabled}
              onChange={(event) =>
                change({
                  ...value,
                  minutesBefore: Math.min(
                    1440,
                    Math.max(1, Math.round(Number(event.currentTarget.value) || 1)),
                  ),
                })
              }
            />
          </label>
        )}
      </div>
      <div className={styles.field}>
        <span className={styles.label}>{t("routines.calendar.scope")}</span>
        <div className={styles.row}>
          <span className={styles.grow}>
            {value.calendarIds.length
              ? (calendars ?? [])
                  .filter((item) => value.calendarIds.includes(item.id))
                  .map((item) => item.title)
                  .join(" · ") || t("routines.calendar.count", { count: value.calendarIds.length })
              : t("routines.calendar.all")}
          </span>
          <Button
            variant="secondary"
            disabled={disabled || action.disabled || !connected || !botId}
            onClick={() => {
              if (peer)
                void action
                  .run((signal) =>
                    peer.call(
                      "routines.calendarList",
                      { botId, connectorId: value.connectorId },
                      { signal },
                    ),
                  )
                  .then((result) => {
                    if (result) setCalendars(result.items);
                  });
            }}
          >
            {t("routines.calendar.choose")}
          </Button>
        </div>
        {calendars && (
          <div className={styles.chips}>
            <button
              type="button"
              className={styles.chip}
              aria-pressed={!value.calendarIds.length}
              disabled={disabled}
              onClick={() => change({ ...value, calendarIds: [] })}
            >
              {t("routines.calendar.all")}
            </button>
            {calendars.map((item) => {
              const on = value.calendarIds.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={styles.chip}
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => toggle(item.id, !on)}
                >
                  {item.title || item.id}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <p className={styles.note}>{t("routines.calendar.hint")}</p>
      {sources && !connected && (
        <p className={styles.warn}>{t("routines.calendar.needConnection")}</p>
      )}
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
    </>
  );
}
