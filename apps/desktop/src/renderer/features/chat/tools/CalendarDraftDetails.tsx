import { CalendarDraftContentSchema } from "@pibot/protocol";
import { approvalStyles as styles, useSettings } from "@pibot/renderer-kit";

export function calendarDraftContent(content: string | undefined) {
  if (content === undefined) return;
  try {
    const parsed = CalendarDraftContentSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}

/** The approved payload remains immutable; this is only a local, plain-text projection. */
export function CalendarDraftDetails({
  event,
  calendarName,
  timeZone,
}: {
  event: NonNullable<ReturnType<typeof calendarDraftContent>>;
  calendarName?: string;
  timeZone?: string;
}) {
  const { t, language } = useSettings();
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const format = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone: zone,
  });
  const rows = [
    [
      t("draft.calendar.calendar"),
      calendarName ??
        (event.calendarId
          ? `${t("draft.calendar.unnamed")} · ${event.calendarId.length > 16 ? `${event.calendarId.slice(0, 8)}…${event.calendarId.slice(-4)}` : event.calendarId}`
          : t("draft.calendar.default")),
    ],
    [t("draft.calendar.event"), event.title],
    [
      t("draft.calendar.time"),
      `${timeZone ? calendarTimeLabel(event.start, zone, language) : format.format(new Date(event.start))} – ${timeZone ? calendarTimeLabel(event.end, zone, language) : `${format.format(new Date(event.end))} (${zone})`}${event.allDay ? ` · ${t("draft.calendar.allDay")}` : ""}`,
    ],
    [t("draft.calendar.location"), event.location || "—"],
    ...(event.notes ? [[t("draft.calendar.notes"), event.notes]] : []),
  ];
  return (
    <dl className={styles.facts}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Show each endpoint's actual offset: a single event can cross a DST transition. */
export function calendarTimeLabel(value: string, zone: string, language: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const offset = part("timeZoneName")
    .replace(/^GMT$/, "GMT+0")
    .replace(/^GMT([+-])0?(\d+):00$/, "GMT$1$2");
  const clock = `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}${part("second") === "00" ? "" : `:${part("second")}`}`;
  return language === "zh" ? `${clock}（${zone}, ${offset}）` : `${clock} (${zone}, ${offset})`;
}
