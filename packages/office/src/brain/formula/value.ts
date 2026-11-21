/** Excel 的错误值以普通值返回，运算遇到时逐层传播，避免在求值里抛异常。 */
export const ERROR_CODES = [
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type Scalar = number | string | boolean | null;
export class FormulaFault {
  // The office worker runs on Node's type stripping, which has no parameter properties.
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    this.code = code;
  }
}
export type Value = Scalar | FormulaFault;
export type Arg = Value | Value[][];
export type FormulaFunction = (args: Arg[]) => Value;

export function fault(code: ErrorCode) {
  return new FormulaFault(code);
}
// 参数可能是标量、区域，也可能是函数内部的中间结果（如 number[]），所以收 unknown。
export function isFault(value: unknown): value is FormulaFault {
  return value instanceof FormulaFault;
}

/** Excel 的常规格式：最多 15 位有效数字，整数不带小数点。 */
export function numberText(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const rounded = Number(value.toPrecision(15));
  return String(rounded);
}

export function toText(value: Value): string | FormulaFault {
  if (isFault(value)) return value;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return numberText(value);
  return value;
}

const NUMERIC = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?%?$/u;
export function toNumber(value: Value): number | FormulaFault {
  if (isFault(value)) return value;
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const trimmed = value.trim();
  if (!NUMERIC.test(trimmed)) return fault("#VALUE!");
  const percent = trimmed.endsWith("%");
  const parsed = Number(percent ? trimmed.slice(0, -1) : trimmed);
  if (!Number.isFinite(parsed)) return fault("#VALUE!");
  return percent ? parsed / 100 : parsed;
}

export function toBoolean(value: Value): boolean | FormulaFault {
  if (isFault(value)) return value;
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value.trim().toUpperCase() === "TRUE") return true;
  if (value.trim().toUpperCase() === "FALSE") return false;
  return fault("#VALUE!");
}

export function toScalar(value: Arg): Value {
  if (!Array.isArray(value)) return value;
  if (value.length === 1 && (value[0]?.length ?? 0) === 1) return value[0]?.[0] ?? null;
  return fault("#VALUE!");
}

export function flatten(value: Arg): Value[] {
  return Array.isArray(value) ? value.flat() : [value];
}

export interface Cell {
  column: number;
  row: number;
}
export function columnName(column: number) {
  let value = "";
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26))
    value = String.fromCharCode(65 + ((rest - 1) % 26)) + value;
  return value;
}
export function cellName(cell: Cell) {
  return `${columnName(cell.column)}${cell.row}`;
}
const CELL = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/u;
export function parseCell(source: string): Cell | undefined {
  const match = CELL.exec(source.toUpperCase());
  if (!match) return;
  let column = 0;
  for (const char of match[1] ?? "") column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16384 || row > 1048576) return;
  return { column, row };
}

const DAY = 86_400_000;
// 1900 日期系统以 1899-12-30 为 0；Excel 的 1900 闰年错误只影响 1900-03-01 之前，忽略。
export function dateToSerial(date: Date): number {
  return Math.round(
    (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
      Date.UTC(1899, 11, 30)) /
      DAY,
  );
}
export function serialToDate(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * DAY);
}
