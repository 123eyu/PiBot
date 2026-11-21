import {
  type Arg,
  type FormulaFault,
  fault,
  flatten,
  isFault,
  toBoolean,
  toNumber,
  toScalar,
  toText,
  type Value,
} from "./value.ts";

export function num(value: Arg): number | FormulaFault {
  return toNumber(toScalar(value));
}
export function text(value: Arg): string | FormulaFault {
  return toText(toScalar(value));
}
export function bool(value: Arg): boolean | FormulaFault {
  return toBoolean(toScalar(value));
}
export function scalar(value: Arg): Value {
  return toScalar(value);
}
export function matrix(value: Arg): Value[][] | FormulaFault {
  if (isFault(value)) return value;
  if (!Array.isArray(value)) return [[value]];
  return value;
}

/** 区域里的文本、布尔和空白不参与统计；直接传入的文本按 Excel 规则转换。 */
export function numbers(values: Arg[]): number[] | FormulaFault {
  const result: number[] = [];
  for (const arg of values) {
    for (const value of flatten(arg)) {
      if (value === null || typeof value === "string") continue;
      if (isFault(value)) return value;
      if (typeof value === "number") result.push(value);
    }
  }
  return result;
}
export function numbersStrict(values: Arg[]): number[] | FormulaFault {
  const result: number[] = [];
  for (const arg of values) {
    const direct = !Array.isArray(arg);
    for (const value of flatten(arg)) {
      if (!direct && (value === null || typeof value === "string" || typeof value === "boolean"))
        continue;
      if (!direct && isFault(value)) return value;
      const parsed = toNumber(value);
      if (isFault(parsed)) return parsed;
      result.push(parsed);
    }
  }
  return result;
}

const COMPARE = /^(<=|>=|<>|=|<|>)/u;
const NUMERIC = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?%?$/u;

function wildcard(source: string) {
  const pattern = source
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${pattern}$`, "iu");
}

/** 条件既可以是比较式（">=10"），也可以是通配文本或数字。 */
export function criteriaMatcher(criteria: Value) {
  let operator = "=";
  let rest = criteria;
  if (typeof criteria === "string") {
    const match = COMPARE.exec(criteria);
    if (match) {
      operator = match[1] as string;
      rest = criteria.slice(operator.length);
    }
  }
  try {
    rest =
      rest !== null && NUMERIC.test(String(rest)) ? Number(String(rest).replace("%", "")) : rest;
  } catch {
    // 条件只用于比较；转换失败时保留原文按文本处理。
  }
  const percent = typeof criteria === "string" && criteria.trim().endsWith("%");
  if (typeof rest === "number" && percent) rest /= 100;
  const needle = rest;
  return (value: Value): boolean => {
    if (isFault(value) || isFault(criteria)) return false;
    const comparable =
      typeof needle === "number"
        ? typeof value === "number"
          ? value
          : value === null || value === ""
            ? null
            : Number(value)
        : typeof value === "string"
          ? value
          : value === null
            ? ""
            : toText(value);
    let order = 0;
    if (comparable === null || Number.isNaN(comparable)) order = needle === "" ? 0 : -1;
    else if (typeof comparable === "number" && typeof needle === "number")
      order = comparable === needle ? 0 : comparable < needle ? -1 : 1;
    else {
      const left = String(comparable).toLowerCase();
      const right = String(needle).toLowerCase();
      if (typeof needle === "string" && (operator === "=" || operator === "<>"))
        return operator === "=" ? wildcard(needle).test(left) : !wildcard(needle).test(left);
      order = left === right ? 0 : left < right ? -1 : 1;
    }
    switch (operator) {
      case "=":
        return order === 0;
      case "<>":
        return order !== 0;
      case "<":
        return order < 0;
      case ">":
        return order > 0;
      case "<=":
        return order <= 0;
      default:
        return order >= 0;
    }
  };
}

export function conditionalPairs(args: Arg[]) {
  const pairs: { range: Value[][]; test: (value: Value) => boolean }[] = [];
  for (let index = 0; index + 1 < args.length; index += 2) {
    const range = matrix(args[index] as Arg);
    if (isFault(range)) return range;
    if (!Array.isArray(args[index + 1])) return fault("#VALUE!") as unknown as FormulaFault;
    pairs.push({ range, test: criteriaMatcher(toScalar(args[index + 1] as Arg)) });
  }
  return pairs;
}
