import type { FormulaFunction } from "../value.ts";
import { dateFunctions } from "./date.ts";
import { logicFunctions } from "./logic.ts";
import { lookupFunctions } from "./lookup.ts";
import { mathFunctions } from "./math.ts";
import { textFunctions } from "./text.ts";

/** 白名单之外的函数一律由 Excel 打开时计算，避免缓存值算错。 */
export const FUNCTIONS: Record<string, FormulaFunction> = {
  ...mathFunctions,
  ...textFunctions,
  ...logicFunctions,
  ...lookupFunctions,
  ...dateFunctions,
};

const extra = [
  "ACOS",
  "ASIN",
  "ATAN",
  "ATAN2",
  "COS",
  "DEGREES",
  "RADIANS",
  "SIN",
  "TAN",
  "RAND",
  "RANDBETWEEN",
  "TODAY",
  "NOW",
  "SUMIFS",
  "AVERAGEIFS",
  "COUNTIFS",
  "MAXIFS",
  "MINIFS",
  "CONCAT",
  "TEXTJOIN",
  "XLOOKUP",
  "IFS",
  "SWITCH",
  "DAYS",
  "EDATE",
  "EOMONTH",
  "WEEKNUM",
  "PERCENTILE",
  "VAR",
  "VARP",
  "STDEVP",
  "RANK",
  "MEDIAN",
  "LARGE",
  "SMALL",
];

/**
 * 允许写进文件的函数。表里的都已有求值实现；extra 里的只在 Excel 里算，
 * 写入时不带缓存值，打开后重算。
 */
export const ALLOWED_FUNCTIONS = new Set([...Object.keys(FUNCTIONS), ...extra]);
