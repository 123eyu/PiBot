import { num, text } from "../common.ts";
import {
  type Arg,
  type FormulaFunction,
  fault,
  isFault,
  numberText,
  serialToDate,
  type Value,
} from "../value.ts";

function numberFormat(value: number, pattern: string) {
  const decimals = /\.(0+)/u.exec(pattern)?.[1]?.length ?? 0;
  const percent = pattern.includes("%");
  const scaled = percent ? value * 100 : value;
  let body = Math.abs(scaled).toFixed(decimals);
  if (pattern.includes("#,##")) body = body.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${scaled < 0 ? "-" : ""}${body}${percent ? "%" : ""}`;
}

function dateFormat(serial: number, pattern: string) {
  const date = serialToDate(serial);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  let result = "";
  let afterHour = false;
  for (let index = 0; index < pattern.length; ) {
    const char = pattern[index] as string;
    if (char === "y" || char === "Y") {
      let end = index;
      while (pattern[end]?.toLowerCase() === "y") end++;
      result += end - index > 2 ? String(date.getUTCFullYear()) : pad(date.getUTCFullYear() % 100);
      index = end;
    } else if (char === "m" || char === "M") {
      let end = index;
      while (pattern[end]?.toLowerCase() === "m") end++;
      const length = end - index;
      result +=
        afterHour && length <= 2
          ? pad(date.getUTCMinutes())
          : length >= 3
            ? String(date.getUTCMonth() + 1)
            : pad(date.getUTCMonth() + 1);
      index = end;
    } else if (char === "d" || char === "D") {
      let end = index;
      while (pattern[end]?.toLowerCase() === "d") end++;
      result += end - index > 1 ? pad(date.getUTCDate()) : String(date.getUTCDate());
      index = end;
    } else if (char === "h" || char === "H") {
      let end = index;
      while (pattern[end]?.toLowerCase() === "h") end++;
      result += pad(date.getUTCHours());
      afterHour = true;
      index = end;
    } else if (char === "s" || char === "S") {
      let end = index;
      while (pattern[end]?.toLowerCase() === "s") end++;
      result += pad(date.getUTCSeconds());
      index = end;
    } else {
      result += char;
      index++;
    }
  }
  return result;
}

function joinText(args: Arg[], separator: string, ignoreEmpty: boolean): Value {
  const parts: string[] = [];
  for (const arg of args) {
    const values = Array.isArray(arg) ? arg.flat() : [arg];
    for (const value of values) {
      if (isFault(value)) return value;
      if (value === null) continue;
      const converted = typeof value === "string" ? value : valueText(value);
      if (ignoreEmpty && converted === "") continue;
      parts.push(converted);
    }
  }
  return parts.join(separator);
}

function valueText(value: Value): string {
  if (value === null) return "";
  if (isFault(value)) return value.code;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return numberText(value);
}

export const textFunctions: Record<string, FormulaFunction> = {
  CONCAT: (args) => joinText(args, "", false),
  CONCATENATE: (args) => joinText(args, "", false),
  TEXTJOIN: (args) => {
    const separator = text(args[0] ?? null);
    if (isFault(separator)) return separator;
    const ignore = args[1] === undefined ? true : Boolean(args[1]);
    return joinText(args.slice(2), separator, ignore);
  },
  LEN: (args) => {
    const value = text(args[0] ?? null);
    return isFault(value) ? value : value.length;
  },
  LEFT: (args) => {
    const value = text(args[0] ?? null);
    if (isFault(value)) return value;
    const count = args[1] === undefined ? 1 : num(args[1]);
    return isFault(count) ? count : value.slice(0, Math.max(0, Math.trunc(count)));
  },
  RIGHT: (args) => {
    const value = text(args[0] ?? null);
    if (isFault(value)) return value;
    const count = args[1] === undefined ? 1 : num(args[1]);
    if (isFault(count)) return count;
    const size = Math.max(0, Math.trunc(count));
    return size === 0 ? "" : value.slice(-size);
  },
  MID: (args) => {
    const value = text(args[0] ?? null);
    if (isFault(value)) return value;
    const start = num(args[1] ?? null);
    if (isFault(start)) return start;
    const count = num(args[2] ?? null);
    if (isFault(count)) return count;
    if (start < 1 || count < 0) return fault("#VALUE!");
    return value.slice(Math.trunc(start) - 1, Math.trunc(start) - 1 + Math.trunc(count));
  },
  LOWER: (args) => {
    const value = text(args[0] ?? null);
    return isFault(value) ? value : value.toLowerCase();
  },
  UPPER: (args) => {
    const value = text(args[0] ?? null);
    return isFault(value) ? value : value.toUpperCase();
  },
  TRIM: (args) => {
    const value = text(args[0] ?? null);
    return isFault(value) ? value : value.trim().replace(/\s+/gu, " ");
  },
  PROPER: (args) => {
    const value = text(args[0] ?? null);
    if (isFault(value)) return value;
    return value.replace(
      /(^|[^A-Za-z])([A-Za-z])([A-Za-z]*)/gu,
      (_whole, lead, first, rest) => `${lead}${first.toUpperCase()}${rest.toLowerCase()}`,
    );
  },
  SUBSTITUTE: (args) => {
    const value = text(args[0] ?? null);
    if (isFault(value)) return value;
    const from = text(args[1] ?? null);
    if (isFault(from)) return from;
    const to = text(args[2] ?? null);
    if (isFault(to)) return to;
    if (from === "") return value;
    if (args[3] === undefined) return value.split(from).join(to);
    const occurrence = num(args[3]);
    if (isFault(occurrence)) return occurrence;
    const position = Math.trunc(occurrence);
    if (position < 1) return fault("#VALUE!");
    let offset = -1;
    for (let seen = 0; seen < position; seen++) {
      offset = value.indexOf(from, offset + 1);
      if (offset < 0) return value;
    }
    return value.slice(0, offset) + to + value.slice(offset + from.length);
  },
  REPLACE: (args) => {
    const value = text(args[0] ?? null);
    if (isFault(value)) return value;
    const start = num(args[1] ?? null);
    if (isFault(start)) return start;
    const count = num(args[2] ?? null);
    if (isFault(count)) return count;
    const replacement = text(args[3] ?? null);
    if (isFault(replacement)) return replacement;
    if (start < 1 || count < 0) return fault("#VALUE!");
    const from = Math.trunc(start) - 1;
    return value.slice(0, from) + replacement + value.slice(from + Math.trunc(count));
  },
  FIND: (args) => {
    const needle = text(args[0] ?? null);
    if (isFault(needle)) return needle;
    const value = text(args[1] ?? null);
    if (isFault(value)) return value;
    const start = args[2] === undefined ? 1 : num(args[2]);
    if (isFault(start)) return start;
    const index = value.indexOf(needle, Math.max(0, Math.trunc(start) - 1));
    return index < 0 ? fault("#VALUE!") : index + 1;
  },
  SEARCH: (args) => {
    const needle = text(args[0] ?? null);
    if (isFault(needle)) return needle;
    const value = text(args[1] ?? null);
    if (isFault(value)) return value;
    const start = args[2] === undefined ? 0 : Math.max(0, Math.trunc(num(args[2]) as number) - 1);
    const index = value.toLowerCase().indexOf(needle.toLowerCase(), start);
    return index < 0 ? fault("#VALUE!") : index + 1;
  },
  REPT: (args) => {
    const value = text(args[0] ?? null);
    if (isFault(value)) return value;
    const count = num(args[1] ?? null);
    if (isFault(count)) return count;
    const size = Math.trunc(count);
    if (size < 0) return fault("#VALUE!");
    return value.repeat(Math.min(size, 32_767 / Math.max(1, value.length)));
  },
  VALUE: (args) => {
    const raw = text(args[0] ?? null);
    if (isFault(raw)) return raw;
    const parsed = Number(raw.replace(/[,%$\s]/gu, ""));
    return Number.isFinite(parsed) ? parsed : fault("#VALUE!");
  },
  EXACT: (args) => {
    const left = text(args[0] ?? null);
    if (isFault(left)) return left;
    const right = text(args[1] ?? null);
    return isFault(right) ? right : left === right;
  },
  CHAR: (args) => {
    const code = num(args[0] ?? null);
    if (isFault(code)) return code;
    return String.fromCharCode(Math.trunc(code));
  },
  CODE: (args) => {
    const value = text(args[0] ?? null);
    if (isFault(value)) return value;
    return value.length === 0 ? fault("#VALUE!") : (value.codePointAt(0) ?? 0);
  },
  TEXT: (args) => {
    const pattern = text(args[1] ?? null);
    if (isFault(pattern)) return pattern;
    const value = args[0] ?? null;
    if (typeof value === "string" && !pattern.match(/[0#%]/u)) return value;
    const parsed = num(value);
    if (isFault(parsed)) return parsed;
    return /[ymdhs]/iu.test(pattern) ? dateFormat(parsed, pattern) : numberFormat(parsed, pattern);
  },
};
