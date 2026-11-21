/**
 * Routine times read like the rest of the app: date plus 24-hour minutes, no seconds. The bare
 * toLocaleString default showed "11/14/2026, 8:30:00 AM" next to the chat's "17:09".
 */
export function routineTime(value: string | number | Date, language: string, timeZone?: string) {
  return new Date(value).toLocaleString(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
}
