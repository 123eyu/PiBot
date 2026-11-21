import { OUTPUT_ROOT_SEGMENTS } from "@pibot/brain/kit";
import type { Routine, RoutineOutput, RoutineRun } from "@pibot/protocol";

type Granularity = Exclude<RoutineOutput["period"], "auto">;

/**
 * A cron on one day of the month (or in chosen months) repeats monthly, one on a single weekday
 * weekly, anything else (weekdays, every day, hourly) daily. Several runs a day share the day's
 * folder: the period is the unit the next run compares with, not the run.
 */
function cronGranularity(expr: string): Granularity {
  const [, , dom = "*", month = "*", dow = "*"] = expr.trim().split(/\s+/);
  const single = (field: string) => /^\d+$/.test(field);
  if (single(dom) || month !== "*") return "month";
  if (single(dow)) return "week";
  return "day";
}

function localDate(at: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

// ISO 8601 week: the week with the year's first Thursday is week 1.
function isoWeek(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - first.getTime()) / 86400000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * The period one run belongs to, from its occurrence time (a resume keeps the original's
 * `scheduledFor`, so it lands in the same folder). The trigger that fired decides the calendar
 * and the time zone; manual and folder runs count daily in the first cron's (or system) zone.
 */
export function periodKey(
  routine: Pick<Routine, "triggers" | "output">,
  run: Pick<RoutineRun, "triggerId" | "scheduledFor">,
  systemTimeZone: string,
) {
  const fired = routine.triggers.find((t) => t.id === run.triggerId)?.config;
  const cron = routine.triggers.find((t) => t.config.kind === "cron")?.config;
  const calendar = fired?.kind === "cron" ? fired : fired ? undefined : cron;
  const zoned = fired?.kind === "cron" || fired?.kind === "once" ? fired : cron;
  const timeZone = zoned && "timezone" in zoned ? zoned.timezone : systemTimeZone;
  const granularity: Granularity =
    routine.output.period !== "auto"
      ? routine.output.period
      : calendar?.kind === "cron"
        ? cronGranularity(calendar.expr)
        : "day";
  const { year, month, day } = localDate(run.scheduledFor, timeZone);
  if (granularity === "month") return `${year}-${pad(month)}`;
  if (granularity === "week") {
    const week = isoWeek(year, month, day);
    return `${week.year}-W${pad(week.week)}`;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** A routine name as one folder name on every platform (no separators, reserved names, end dots). */
export function folderName(name: string) {
  const cleaned = [...name]
    .map((c) => (c.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(c) ? "_" : c))
    .join("")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 60);
  if (!cleaned) return "_";
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** The artifact root of a routine relative to its primary folder, as path segments. */
export function outputSegments(routine: Pick<Routine, "name" | "output">) {
  return routine.output.folder
    ? routine.output.folder.split("/")
    : // Default artifact root (`.pibot/out`); the routine's own folder goes below.
      [...OUTPUT_ROOT_SEGMENTS, folderName(routine.name)];
}
