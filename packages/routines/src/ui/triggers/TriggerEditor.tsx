import type { RoutineDraft } from "@pibot/protocol";
import { useSettings } from "@pibot/renderer-kit";
import { Button, type IconName, IconTile, type Tone } from "@pibot/ui";
import { useState } from "react";
import styles from "../shell/routines.module.css";
import { CalendarFields } from "./CalendarFields.tsx";
import {
  ConnectionFields,
  firstConnectionCheck,
  type useTriggerSources,
} from "./ConnectionFields.tsx";
import { CronFields } from "./CronFields.tsx";
import { systemTimezone } from "./cron.ts";
import { FolderFields } from "./FolderFields.tsx";
import { OnceFields } from "./OnceFields.tsx";

export type Trigger = RoutineDraft["triggers"][number];
const TITLES = {
  cron: "routines.cron",
  once: "routines.once",
  folder: "routines.folder",
  connection: "routines.connection",
  calendar: "routines.calendar",
  github: "routines.github",
} as const;
// Each trigger kind keeps one colour and mark on its tile and on the added trigger's card.
const MARKS: Record<Trigger["kind"], { icon: IconName; tone: Tone }> = {
  cron: { icon: "refresh", tone: "orange" },
  once: { icon: "pin", tone: "pink" },
  folder: { icon: "folder", tone: "amber" },
  connection: { icon: "link", tone: "blue" },
  calendar: { icon: "clock", tone: "teal" },
  github: { icon: "link", tone: "neutral" },
};
export function TriggerEditor({
  botId,
  sources,
  values,
  change,
  disabled = false,
  initialOnce,
}: {
  botId: string;
  /** Loaded by the editor, which also refuses to save a trigger they do not offer. */
  sources: ReturnType<typeof useTriggerSources>;
  values: Trigger[];
  change(values: Trigger[]): void;
  disabled?: boolean;
  initialOnce?: string;
}) {
  const { t } = useSettings();
  const [ids, setIds] = useState(() => values.map(() => crypto.randomUUID()));
  const single = values.some((v) => v.kind === "once");
  const full = disabled || single || values.length >= 32;
  const firstCheck = firstConnectionCheck(sources.value);
  const calendar = sources.value?.calendars[0];
  const add = (value: Trigger) => {
    setIds([...ids, crypto.randomUUID()]);
    change([...values, value]);
  };
  const replace = (index: number) => (next: Trigger) =>
    change(values.map((v, i) => (i === index ? next : v)));
  return (
    <section className={styles.formCard} data-mark="orange">
      <h2>{t("routines.triggers")}</h2>
      {values.map((value, index) => (
        <div className={styles.card} key={ids[index] ?? index}>
          <div className={styles.row}>
            <IconTile icon={MARKS[value.kind].icon} tone={MARKS[value.kind].tone} size="sm" />
            <h3 className={styles.grow}>{t(TITLES[value.kind])}</h3>
            <Button
              variant="ghost"
              // A retired trigger can always go, even as the last one: it can never fire.
              disabled={disabled || (values.length <= 1 && value.kind !== "github")}
              onClick={() => {
                setIds(ids.filter((_, i) => i !== index));
                change(values.filter((_, i) => i !== index));
              }}
            >
              {t("routines.remove")}
            </Button>
          </div>
          {value.kind === "cron" ? (
            <CronFields disabled={disabled} value={value} change={replace(index)} />
          ) : value.kind === "once" ? (
            <OnceFields
              initialLocalTime={initialOnce}
              disabled={disabled}
              value={value}
              change={replace(index)}
            />
          ) : value.kind === "connection" ? (
            <ConnectionFields
              value={value}
              disabled={disabled}
              sources={sources.value}
              change={replace(index)}
            />
          ) : value.kind === "calendar" ? (
            <CalendarFields
              value={value}
              disabled={disabled}
              sources={sources.value}
              botId={botId}
              change={replace(index)}
            />
          ) : value.kind === "github" ? (
            <p className={styles.warn}>{t("routines.githubRetired")}</p>
          ) : (
            <FolderFields value={value} change={replace(index)} />
          )}
        </div>
      ))}
      <div className={styles.trigTiles}>
        <Button
          variant="secondary"
          disabled={disabled || single}
          onClick={() => {
            setIds([crypto.randomUUID()]);
            change([{ kind: "once", at: "", timezone: systemTimezone() }]);
          }}
        >
          <IconTile icon={MARKS.once.icon} tone={MARKS.once.tone} />
          {t("routines.once")}
        </Button>
        <Button
          variant="secondary"
          disabled={disabled || (!single && values.length >= 32)}
          onClick={() => {
            const trigger = {
              kind: "cron",
              expr: "30 8 * * *",
              timezone: systemTimezone(),
            } as const;
            if (single) {
              setIds([crypto.randomUUID()]);
              change([trigger]);
            } else add(trigger);
          }}
        >
          <IconTile icon={MARKS.cron.icon} tone={MARKS.cron.tone} />
          {t("routines.cron")}
        </Button>
        <Button
          variant="secondary"
          disabled={full}
          onClick={() =>
            add({
              kind: "folder",
              path: "",
              events: "new",
              pattern: "*",
              recursive: false,
              cooldownMin: 5,
            })
          }
        >
          <IconTile icon={MARKS.folder.icon} tone={MARKS.folder.tone} />
          {t("routines.folder")}
        </Button>
        <Button
          variant="secondary"
          disabled={full || !firstCheck}
          onClick={() => {
            if (firstCheck) add({ kind: "connection", ...firstCheck, intervalMin: 15 });
          }}
        >
          <IconTile icon={MARKS.connection.icon} tone={MARKS.connection.tone} />
          {t("routines.connection")}
        </Button>
        <Button
          variant="secondary"
          disabled={full || !calendar}
          onClick={() => {
            if (calendar)
              add({
                kind: "calendar",
                connectorId: calendar.connectorId,
                event: "before_start",
                minutesBefore: 15,
                calendarIds: [],
              });
          }}
        >
          <IconTile icon={MARKS.calendar.icon} tone={MARKS.calendar.tone} />
          {t("routines.calendar")}
        </Button>
      </div>
      <div className={styles.triggerNotes}>
        {sources.value && !sources.value.connections.length && (
          <span className={styles.note}>
            {sources.value.blocked[0]
              ? t(`routines.connection.blocked.${sources.value.blocked[0].reason}`, {
                  name: sources.value.blocked[0].name,
                })
              : t("routines.connection.none")}
          </span>
        )}
        {sources.value && sources.value.connections.length > 0 && !firstCheck && (
          <span className={styles.note}>{t("routines.connection.noneCheckable")}</span>
        )}
        {sources.value && !calendar && (
          <span className={styles.note}>{t("routines.calendar.needConnectionNote")}</span>
        )}
      </div>
      {sources.error && (
        <p role="alert" className={styles.error}>
          {t(sources.error)} <Button onClick={sources.refresh}>{t("common.retry")}</Button>
        </p>
      )}
    </section>
  );
}
