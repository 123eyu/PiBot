/**
 * Calendar arithmetic on local wall-clock days. Values stay in the strings the native inputs
 * produced (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `HH:MM`) so storage, RPC and the callers' timezone
 * logic never see a change; a Date only ever stands for a day at local noon, which keeps day
 * stepping clear of DST jumps that happen around midnight.
 */
export type DatePickerMode = "date" | "datetime" | "time";

export interface Parts {
  day?: Date;
  hour?: number;
  minute?: number;
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

export function dayKey(date: Date) {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function makeDay(year: number, month: number, day: number) {
  return new Date(year, month, day, 12);
}

export function today() {
  const now = new Date();
  return makeDay(now.getFullYear(), now.getMonth(), now.getDate());
}

export function addDays(date: Date, days: number) {
  return makeDay(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Keeps the day of month where it exists (Jan 31 + 1 month is Feb 28/29, not Mar 3). */
export function addMonths(date: Date, months: number) {
  const first = makeDay(date.getFullYear(), date.getMonth() + months, 1);
  const length = makeDay(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return makeDay(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), length));
}

export function sameDay(a: Date | undefined, b: Date | undefined) {
  return !!a && !!b && dayKey(a) === dayKey(b);
}

function parseDayKey(text: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return undefined;
  const date = makeDay(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Rejects rollover such as 2026-02-31, which Date would silently turn into March.
  return dayKey(date) === match[0] ? date : undefined;
}

function parseClock(text: string) {
  const match = /^(\d{2}):(\d{2})/.exec(text);
  if (!match) return {};
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : {};
}

export function parseValue(mode: DatePickerMode, value: string): Parts {
  if (mode === "time") return parseClock(value);
  const day = parseDayKey(value);
  if (mode === "date") return { day };
  return { day, ...parseClock(value.slice(11)) };
}

export function clockText(hour: number, minute: number) {
  return `${pad(hour)}:${pad(minute)}`;
}

/** Fills whichever half is missing so a datetime always serializes as a whole local time. */
export function formatValue(mode: DatePickerMode, parts: Parts, fallback: Date) {
  const clock = clockText(parts.hour ?? 9, parts.minute ?? 0);
  if (mode === "time") return clock;
  const day = dayKey(parts.day ?? fallback);
  return mode === "date" ? day : `${day}T${clock}`;
}

export function withinRange(date: Date, min?: string, max?: string) {
  const key = dayKey(date);
  return (!min || key >= min.slice(0, 10)) && (!max || key <= max.slice(0, 10));
}

/** Strictly after `from`: on a Monday, 下周一 means a week later, not today. */
export function nextMonday(from: Date) {
  return addDays(from, (8 - from.getDay()) % 7 || 7);
}

/** Six full weeks, the fixed grid height the design uses so the popover never jumps. */
export function monthGrid(view: Date, weekStartsOn: 0 | 1) {
  const first = makeDay(view.getFullYear(), view.getMonth(), 1);
  const start = addDays(first, -((first.getDay() - weekStartsOn + 7) % 7));
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day)),
  );
}

const isChinese = (locale: string) => locale.toLowerCase().startsWith("zh");

/**
 * The approved field text: zh 「11月20日 周五」, en "Fri, Nov 20"; the year only when it is not
 * this year. Chinese is assembled from two parts because Intl runs them together without a space.
 */
export function dayText(date: Date, locale: string, now: Date) {
  const year = date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const };
  if (isChinese(locale)) {
    const monthDay = new Intl.DateTimeFormat(locale, { ...year, month: "long", day: "numeric" });
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
    return `${monthDay.format(date)} ${weekday.format(date)}`;
  }
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...year,
  }).format(date);
}

export function valueText(mode: DatePickerMode, parts: Parts, locale: string, now: Date) {
  const clock =
    parts.hour === undefined || parts.minute === undefined
      ? undefined
      : clockText(parts.hour, parts.minute);
  if (mode === "time") return clock;
  if (!parts.day) return undefined;
  const day = dayText(parts.day, locale, now);
  return mode === "datetime" && clock ? `${day} · ${clock}` : day;
}

export function monthTitle(date: Date, locale: string) {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(date);
}

/** zh column heads are the single characters 一…日; other languages keep the short names. */
export function weekdayHeads(locale: string, weekStartsOn: 0 | 1) {
  const short = new Intl.DateTimeFormat(locale, {
    weekday: isChinese(locale) ? "narrow" : "short",
  });
  const long = new Intl.DateTimeFormat(locale, { weekday: "long" });
  // 2026-11-01 is a Sunday; any known Sunday works as the anchor.
  return Array.from({ length: 7 }, (_, index) => {
    const date = makeDay(2026, 10, 1 + ((index + weekStartsOn) % 7));
    return { short: short.format(date), long: long.format(date), weekend: date.getDay() % 6 === 0 };
  });
}

export function fullDayLabel(date: Date, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(date);
}
