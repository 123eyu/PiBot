import { num } from "../common.ts";
import {
  type Arg,
  dateToSerial,
  type FormulaFunction,
  fault,
  isFault,
  serialToDate,
  type Value,
} from "../value.ts";

function serialArg(value: Arg): number | ReturnType<typeof fault> {
  return num(value);
}

function datePart(args: Arg[], part: (date: Date) => number) {
  const serial = serialArg(args[0] ?? null);
  if (isFault(serial)) return serial;
  if (serial < 0) return fault("#NUM!");
  return part(serialToDate(serial));
}

function addMonths(serial: number, months: number) {
  const date = serialToDate(serial);
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + Math.trunc(months), 1),
  );
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(date.getUTCDate(), last));
}

function parseDateText(source: string): number | undefined {
  const match =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u.exec(source.trim()) ??
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/u.exec(source.trim());
  if (!match) return;
  const first = Number(match[1]);
  const month = match[2] as string;
  const day = match[3] as string;
  const year = first > 31 ? first : Number(match[3]);
  const result =
    first > 31
      ? Date.UTC(year, Number(month) - 1, Number(day))
      : Date.UTC(year, first - 1, Number(month));
  return Math.round((result - Date.UTC(1899, 11, 30)) / 86_400_000);
}

export const dateFunctions: Record<string, FormulaFunction> = {
  DATE: (args) => {
    const year = num(args[0] ?? null);
    if (isFault(year)) return year;
    const month = num(args[1] ?? null);
    if (isFault(month)) return month;
    const day = num(args[2] ?? null);
    if (isFault(day)) return day;
    const normalizedYear = Math.trunc(year) < 1900 ? Math.trunc(year) + 1900 : Math.trunc(year);
    const date = new Date(Date.UTC(normalizedYear, Math.trunc(month) - 1, Math.trunc(day)));
    const serial = dateToSerial(date);
    return serial < 0 ? fault("#NUM!") : serial;
  },
  DAY: (args) => datePart(args, (date) => date.getUTCDate()),
  MONTH: (args) => datePart(args, (date) => date.getUTCMonth() + 1),
  YEAR: (args) => datePart(args, (date) => date.getUTCFullYear()),
  HOUR: (args) => {
    const serial = serialArg(args[0] ?? null);
    if (isFault(serial)) return serial;
    return Math.floor((((serial % 1) + 1) % 1) * 24);
  },
  MINUTE: (args) => {
    const serial = serialArg(args[0] ?? null);
    if (isFault(serial)) return serial;
    return Math.floor(((((serial % 1) + 1) % 1) * 24 * 60) % 60);
  },
  SECOND: (args) => {
    const serial = serialArg(args[0] ?? null);
    if (isFault(serial)) return serial;
    return Math.round(((((serial % 1) + 1) % 1) * 86_400) % 60);
  },
  TIME: (args) => {
    const hour = num(args[0] ?? null);
    if (isFault(hour)) return hour;
    const minute = num(args[1] ?? null);
    if (isFault(minute)) return minute;
    const second = num(args[2] ?? null);
    if (isFault(second)) return second;
    return (((hour * 60 + minute) * 60 + second) % 86_400) / 86_400;
  },
  DATEVALUE: (args) => {
    const value = args[0] ?? null;
    if (typeof value !== "string") return fault("#VALUE!");
    const serial = parseDateText(value);
    return serial === undefined ? fault("#VALUE!") : serial;
  },
  DAYS: (args) => {
    const end = serialArg(args[0] ?? null);
    if (isFault(end)) return end;
    const start = serialArg(args[1] ?? null);
    if (isFault(start)) return start;
    return Math.round(end) - Math.round(start);
  },
  EDATE: (args) => {
    const serial = serialArg(args[0] ?? null);
    if (isFault(serial)) return serial;
    const months = num(args[1] ?? null);
    if (isFault(months)) return months;
    return Math.round((addMonths(serial, months) - Date.UTC(1899, 11, 30)) / 86_400_000);
  },
  EOMONTH: (args) => {
    const serial = serialArg(args[0] ?? null);
    if (isFault(serial)) return serial;
    const months = num(args[1] ?? null);
    if (isFault(months)) return months;
    const date = new Date(addMonths(serial, months));
    const last = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
    return Math.round((last - Date.UTC(1899, 11, 30)) / 86_400_000);
  },
  WEEKDAY: (args) => {
    const serial = serialArg(args[0] ?? null);
    if (isFault(serial)) return serial;
    const type = args[1] === undefined ? 1 : num(args[1]);
    if (isFault(type)) return type;
    if (type < 1 || type > 3) return fault("#NUM!");
    const day = serialToDate(serial).getUTCDay();
    return type === 1 ? day + 1 : type === 2 ? ((day + 6) % 7) + 1 : (day + 6) % 7;
  },
  WEEKNUM: (args) => {
    const serial = serialArg(args[0] ?? null);
    if (isFault(serial)) return serial;
    const date = serialToDate(serial);
    const start = Date.UTC(date.getUTCFullYear(), 0, 1);
    const startSerial = Math.round((start - Date.UTC(1899, 11, 30)) / 86_400_000);
    return Math.floor((serial - startSerial + new Date(start).getUTCDay()) / 7) + 1;
  },
};

export type { Value };
