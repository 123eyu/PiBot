import { setImmediate } from "node:timers/promises";
import { CronExpressionParser } from "cron-parser";

export function nextCron(expr: string, timezone: string, after: number) {
  return CronExpressionParser.parse(expr, { tz: timezone, currentDate: new Date(after) })
    .next()
    .getTime();
}

// Forward iteration preserves the library's DST fold de-duplication; prev() does not.
export async function latestCron(
  expr: string,
  timezone: string,
  from: number,
  to: number,
  signal: AbortSignal,
) {
  if (from >= to) return null;
  // Find the newest occupied window, then enumerate forward; dense multi-year downtime is bounded.
  let end = to;
  for (let windows = 0; windows < 64 && end > from; windows++) {
    signal.throwIfAborted();
    const start = Math.max(from, end - (windows < 2 ? 86400000 : 31 * 86400000));
    const found = await forward(expr, timezone, start, end, signal);
    if (found !== null) return found;
    end = start;
  }
  if (end > from) throw new Error("cron_scan_budget");
  return null;
}
async function forward(
  expr: string,
  timezone: string,
  from: number,
  to: number,
  signal: AbortSignal,
) {
  const sequence = CronExpressionParser.parse(expr, {
    tz: timezone,
    currentDate: new Date(from),
    endDate: new Date(to),
  });
  let latest: number | null = null;
  for (let n = 0; sequence.hasNext(); n++) {
    signal.throwIfAborted();
    if (n >= 250000) throw new Error("cron_scan_budget");
    latest = sequence.next().getTime();
    if (n % 256 === 0) await setImmediate(undefined, { signal });
  }
  return latest;
}

export class CronInputError extends Error {
  constructor(code: "invalid_cron" | "cron_too_frequent" | "invalid_timezone") {
    super(code);
  }
}

export async function validateCron(
  expr: string,
  timezone: string,
  minimum: number,
  signal: AbortSignal,
  now = Date.now(),
) {
  if (expr.trim().split(/\s+/).length !== 5 || !/^[\d*,/\-\s]+$/.test(expr))
    throw new CronInputError("invalid_cron");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new CronInputError("invalid_timezone");
  }
  const sequence = (() => {
    try {
      return CronExpressionParser.parse(expr, { tz: timezone, currentDate: new Date(now) });
    } catch {
      throw new CronInputError("invalid_cron");
    }
  })();
  // Intra-hour spacing repeats on every selected day. Crossing hours depends on the selected hours.
  const minutes = sequence.fields.minute.values;
  for (let i = 0; i + 1 < minutes.length; i++) {
    const a = Number(minutes[i]);
    const b = Number(minutes[i + 1]);
    if ((b - a) * 60000 < minimum) throw new CronInputError("cron_too_frequent");
  }
  const hours = sequence.fields.hour.values;
  for (let i = 0; i + 1 < hours.length; i++) {
    const gap =
      (Number(hours[i + 1]) - Number(hours[i])) * 60 + Number(minutes[0]) - Number(minutes.at(-1));
    if (gap * 60000 < minimum) throw new CronInputError("cron_too_frequent");
  }
  // Check midnight crossings over eight years, with a fixed enumeration budget.
  const midnightGap =
    (24 + Number(hours[0]) - Number(hours.at(-1))) * 60 +
    Number(minutes[0]) -
    Number(minutes.at(-1));
  if (midnightGap * 60000 < minimum) {
    let previous = sequence.next().getTime();
    for (let n = 0; n < 300000; n++) {
      signal.throwIfAborted();
      const next = sequence.next().getTime();
      if (next - previous < minimum) throw new CronInputError("cron_too_frequent");
      if (next - now > 8 * 366 * 86400000) break;
      previous = next;
      if (n % 256 === 0) await setImmediate(undefined, { signal });
      if (n === 299999) throw new Error("cron_validation_budget");
    }
  }
  await validateClockTransitions(expr, timezone, minimum, signal, now);
  signal.throwIfAborted();
  return nextCron(expr, timezone, now);
}

async function validateClockTransitions(
  expr: string,
  timezone: string,
  minimum: number,
  signal: AbortSignal,
  now: number,
) {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  });
  const offset = (at: number) =>
    formatter.formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
  const end = now + 8 * 366 * 86400000;
  let previousOffset = offset(now),
    previousDay = now,
    occurrences = 0;
  // Inspect only occupied windows around actual offset changes; sparse hours/dates stay valid.
  for (let day = now + 86400000, n = 0; day <= end; day += 86400000, n++) {
    signal.throwIfAborted();
    if (n % 64 === 0) await setImmediate(undefined, { signal });
    const currentOffset = offset(day);
    if (currentOffset !== previousOffset) {
      const sequence = CronExpressionParser.parse(expr, {
        tz: timezone,
        currentDate: new Date(previousDay - 86400000),
        endDate: new Date(day + 86400000),
      });
      let previous: number | null = null;
      while (sequence.hasNext()) {
        signal.throwIfAborted();
        if (++occurrences > 300000) throw new Error("cron_validation_budget");
        const at = sequence.next().getTime();
        if (previous !== null && at - previous < minimum)
          throw new CronInputError("cron_too_frequent");
        previous = at;
        if (occurrences % 256 === 0) await setImmediate(undefined, { signal });
      }
    }
    previousOffset = currentOffset;
    previousDay = day;
  }
}
