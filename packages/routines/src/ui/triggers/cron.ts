import { createTranslator, type Language } from "@pibot/i18n";

export type CronPreset = "daily" | "weekdays" | "weekly" | "monthly" | "hourly" | "advanced";
export interface CronChoice {
  preset: CronPreset;
  time: string;
  days: number[];
  day: number;
  every: number;
  start: number;
  end: number;
  weekdays: boolean;
  expr: string;
}
export const defaultCron: CronChoice = {
  preset: "daily",
  time: "08:30",
  days: [1],
  day: 1,
  every: 2,
  start: 9,
  end: 18,
  weekdays: false,
  expr: "30 8 * * *",
};
export function presetCron(value: CronChoice): string {
  if (value.preset === "advanced") return value.expr.trim();
  const [hour = Number.NaN, minute = Number.NaN] = value.time.split(":").map(Number);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  )
    return "";
  if (value.preset === "hourly") {
    if (
      ![value.every, value.start, value.end].every(Number.isInteger) ||
      value.every < 1 ||
      value.every > 23 ||
      value.start < 0 ||
      value.end > 23 ||
      value.start > value.end
    )
      return "";
    const hours: number[] = [];
    for (let hour = value.start; hour <= value.end; hour += value.every) hours.push(hour);
    return `0 ${hours.join(",")} * * ${value.weekdays ? "1-5" : "*"}`;
  }
  if (
    value.preset === "monthly" &&
    (!Number.isInteger(value.day) || value.day < 1 || value.day > 31)
  )
    return "";
  if (
    value.preset === "weekly" &&
    (!value.days.length || value.days.some((d) => d < 0 || d > 6 || !Number.isInteger(d)))
  )
    return "";
  return `${minute} ${hour} ${value.preset === "monthly" ? value.day : "*"} * ${value.preset === "weekdays" ? "1-5" : value.preset === "weekly" ? [...new Set(value.days)].sort().join(",") : "*"}`;
}
// Human text never predicts the next occurrence; scheduler remains authoritative for DST/intervals.
export function cronText(expr: string, timezone: string, language: Language): string {
  const t = createTranslator(language);
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = expr.trim().split(/\s+/);
  if (
    minute === "0" &&
    /^\d+(,\d+)+$/.test(hour ?? "") &&
    hour.split(",").every((h) => Number(h) < 24) &&
    day === "*" &&
    month === "*" &&
    (weekday === "*" || weekday === "1-5")
  ) {
    return t("routines.cronHours", {
      days: t(weekday === "1-5" ? "routines.preset.weekdays" : "routines.everyDay"),
      hours: hour
        .split(",")
        .map((h) => h.padStart(2, "0"))
        .join(", "),
      timezone,
    });
  }
  if (
    /^\d+$/.test(minute ?? "") &&
    /^\d+$/.test(hour ?? "") &&
    Number(minute) < 60 &&
    Number(hour) < 24 &&
    month === "*"
  ) {
    const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
    let text: string | undefined;
    if (day === "*" && weekday === "*") text = t("routines.cronDaily", { time });
    else if (day === "*" && weekday === "1-5") text = t("routines.cronWeekdays", { time });
    else if (/^\d+$/.test(day ?? "") && weekday === "*")
      text = t("routines.cronMonthly", { day, time });
    else if (day === "*" && /^[0-6](,[0-6])*$/.test(weekday ?? ""))
      text = t("routines.cronWeekly", {
        days: weekday
          .split(",")
          .map((d) => t(`routines.day.${Number(d) as 0 | 1 | 2 | 3 | 4 | 5 | 6}`))
          .join(language === "zh" ? "、" : ", "),
        time,
      });
    if (text) return `${text} · ${timezone}`;
  }
  return t("routines.cronAdvanced", { expr, timezone });
}
export function systemTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Recover the preset only when it exactly reproduces the saved expression. */
export function cronChoice(expr: string): CronChoice {
  const [minute, hour, day, month, weekday] = expr.trim().split(/\s+/);
  const base = { ...defaultCron, expr };
  if (/^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "") && month === "*") {
    const candidate = { ...base, time: `${hour?.padStart(2, "0")}:${minute?.padStart(2, "0")}` };
    const choice: CronChoice =
      day === "*" && weekday === "*"
        ? { ...candidate, preset: "daily" }
        : day === "*" && weekday === "1-5"
          ? { ...candidate, preset: "weekdays" }
          : day === "*" && /^[0-6](,[0-6])*$/.test(weekday ?? "")
            ? { ...candidate, preset: "weekly", days: weekday?.split(",").map(Number) ?? [] }
            : /^\d+$/.test(day ?? "") && weekday === "*"
              ? { ...candidate, preset: "monthly", day: Number(day) }
              : { ...base, preset: "advanced" };
    if (presetCron(choice) === expr.trim()) return choice;
  }
  return { ...base, preset: "advanced" };
}
