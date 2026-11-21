import {
  CALENDAR_CHECK_INTERVAL_MS,
  type CalendarTrigger,
  type CalendarTriggerEvent,
  type CalendarTriggerState,
} from "@pibot/protocol";
import { z } from "zod";
import { itemKey } from "./connection-checks.ts";

/** "New event" looks this far ahead; the local calendar reads at most 31 days per call. */
const NEW_EVENT_WINDOW_MS = 30 * 86_400_000;
/** An event is still worth a before-start run this long after its due moment was missed. */
const LATE_GRACE_MS = 60_000;
const PAGE_LIMIT = 100;
export const CALENDAR_MAX_PAGES = 10;

export interface CalendarEvent extends CalendarTriggerEvent {
  key: string;
}
const EventSchema = z.object({
  id: z.string().min(1).max(4096),
  title: z.string().max(512).catch(""),
  start: z.string().max(64),
  end: z.string().max(64).nullable().optional(),
  calendarName: z.string().max(512).catch(""),
  allDay: z.boolean().catch(false),
});
const PageSchema = z.object({
  items: z.array(z.unknown()).max(PAGE_LIMIT),
  nextCursor: z.string().max(64).nullable().optional(),
});
const canonical = (value: string | null | undefined) => {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** The range one check reads: the next 30 days, or just past the next before-start moments. */
export function calendarRange(config: CalendarTrigger, now: number) {
  const start = config.event === "new_event" ? now : now - LATE_GRACE_MS;
  const end =
    config.event === "new_event"
      ? now + NEW_EVENT_WINDOW_MS
      : now + config.minutesBefore * 60_000 + CALENDAR_CHECK_INTERVAL_MS + LATE_GRACE_MS;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
export function calendarArgs(
  config: CalendarTrigger,
  range: { start: string; end: string },
  cursor?: string,
) {
  return {
    ...range,
    limit: PAGE_LIMIT,
    ...(config.calendarIds.length ? { calendarIds: config.calendarIds } : {}),
    ...(cursor ? { cursor } : {}),
  };
}
/** One `list_events` page as events; a malformed page fails the check rather than look empty. */
export function calendarPage(value: unknown) {
  const page = PageSchema.parse(value);
  const events: CalendarEvent[] = [];
  for (const raw of page.items) {
    const parsed = EventSchema.safeParse(raw);
    const start = parsed.success ? canonical(parsed.data.start) : null;
    if (!parsed.success || !start) continue;
    events.push({
      // Each occurrence of a repeating event shares its id, so the start is part of the key.
      key: itemKey(`${parsed.data.id}\n${start}`),
      title: parsed.data.title,
      start,
      end: canonical(parsed.data.end),
      calendarName: parsed.data.calendarName,
      allDay: parsed.data.allDay,
    });
  }
  return { events, nextCursor: page.nextCursor ?? null };
}

/**
 * Decides one check. With no state yet (just saved, or resumed), "new event" only records what is
 * there, and "before start" fires only for events whose moment came after `since` (the trigger's
 * creation), so saving a task never fires for events that were already due or already existed.
 */
export function calendarDecision(
  config: CalendarTrigger,
  state: CalendarTriggerState | undefined,
  events: CalendarEvent[],
  complete: boolean,
  now: number,
  since: number,
): { fire: CalendarEvent[]; state: CalendarTriggerState } {
  const checkedAt = new Date(now).toISOString();
  const range = calendarRange(config, now);
  if (config.event === "new_event") {
    // A truncated read has seen only up to its last event; later ones are not known yet.
    const seenUntil = complete ? range.end : (events.at(-1)?.start ?? range.start);
    const keys = [...new Set(events.map((event) => event.key))].slice(0, 1000);
    const seen = new Set(state?.seen ?? []);
    // An event past the previous window's end is entering the window, not new.
    const fire = state
      ? events.filter(
          (event) => !seen.has(event.key) && Date.parse(event.start) <= Date.parse(state.seenUntil),
        )
      : [];
    return { fire, state: { checkedAt, seen: keys, seenUntil, fired: [], nextDueAt: null } };
  }
  const lead = config.minutesBefore * 60_000;
  const fired = new Map((state?.fired ?? []).map((entry) => [entry.key, entry]));
  const timed = events.filter((event) => !event.allDay);
  const due = timed.filter(
    (event) =>
      !fired.has(event.key) &&
      Date.parse(event.start) - lead <= now &&
      Date.parse(event.start) > now - LATE_GRACE_MS,
  );
  for (const event of due) fired.set(event.key, { key: event.key, start: event.start });
  const nextDue = timed
    .filter((event) => !fired.has(event.key))
    .map((event) => Date.parse(event.start) - lead)
    .filter((at) => at > now)
    .sort((a, b) => a - b)[0];
  return {
    // The first check fires only for events that became due after the trigger was saved.
    fire: state ? due : due.filter((event) => Date.parse(event.start) - lead >= since),
    state: {
      checkedAt,
      seen: [],
      seenUntil: range.end,
      // Keep a fired event only until it has started, so the list stays short.
      fired: [...fired.values()]
        .filter((entry) => Date.parse(entry.start) > now - 3_600_000)
        .slice(-500),
      nextDueAt: nextDue === undefined ? null : new Date(nextDue).toISOString(),
    },
  };
}
