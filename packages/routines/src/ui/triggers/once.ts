import { routineTime } from "../format-time.ts";
export function onceLocalTime(at: string, timezone: string) {
  if (!at) return "";
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      calendar: "iso8601",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}.${values.fractionalSecond}`;
}
export function onceText(at: string, timezone: string, language: string) {
  return `${at ? routineTime(at, language, timezone) : "…"} · ${timezone}`;
}
export function offsetText(minutes: number) {
  const value = Math.abs(minutes);
  return `UTC${minutes < 0 ? "−" : "+"}${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
