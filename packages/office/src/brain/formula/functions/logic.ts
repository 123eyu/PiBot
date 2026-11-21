import { bool, scalar } from "../common.ts";
import {
  type Arg,
  type FormulaFunction,
  fault,
  flatten,
  isFault,
  toBoolean,
  type Value,
} from "../value.ts";

function logicalValues(args: Arg[]): boolean[] | ReturnType<typeof fault> {
  const result: boolean[] = [];
  for (const arg of args)
    for (const value of flatten(arg)) {
      if (value === null || typeof value === "string") continue;
      const parsed = toBoolean(value);
      if (isFault(parsed)) return parsed;
      result.push(parsed);
    }
  return result;
}

export const logicFunctions: Record<string, FormulaFunction> = {
  TRUE: () => true,
  FALSE: () => false,
  IF: (args) => {
    const condition = bool(args[0] ?? null);
    if (isFault(condition)) return condition;
    if (condition) return scalar(args[1] ?? true);
    return args.length > 2 ? scalar(args[2] ?? false) : false;
  },
  IFERROR: (args) => {
    const value = scalar(args[0] ?? null);
    return isFault(value) ? scalar(args[1] ?? null) : value;
  },
  IFNA: (args) => {
    const value = scalar(args[0] ?? null);
    return isFault(value) && value.code === "#N/A" ? scalar(args[1] ?? null) : value;
  },
  AND: (args) => {
    const values = logicalValues(args);
    return isFault(values) ? values : values.length > 0 && values.every(Boolean);
  },
  OR: (args) => {
    const values = logicalValues(args);
    return isFault(values) ? values : values.length > 0 && values.some(Boolean);
  },
  NOT: (args) => {
    const value = bool(args[0] ?? null);
    return isFault(value) ? value : !value;
  },
  IFS: (args) => {
    for (let index = 0; index + 1 < args.length; index += 2) {
      const condition = bool(args[index] ?? null);
      if (isFault(condition)) return condition;
      if (condition) return scalar(args[index + 1] ?? null);
    }
    return fault("#N/A");
  },
  SWITCH: (args) => {
    const target = scalar(args[0] ?? null);
    if (isFault(target)) return target;
    let index = 1;
    for (; index + 1 < args.length; index += 2) {
      const candidate = scalar(args[index] ?? null);
      if (isFault(candidate)) return candidate;
      if (candidate === target) return scalar(args[index + 1] ?? null);
    }
    return index < args.length ? scalar(args[index] ?? null) : fault("#N/A");
  },
  ISBLANK: (args) => scalar(args[0] ?? null) === null,
  ISNUMBER: (args) => typeof scalar(args[0] ?? null) === "number",
  ISTEXT: (args) => typeof scalar(args[0] ?? null) === "string",
  ISERROR: (args) => isFault(scalar(args[0] ?? null)),
  ISNA: (args) => {
    const value = scalar(args[0] ?? null);
    return isFault(value) && value.code === "#N/A";
  },
  NA: () => fault("#N/A"),
};

export type { Value };
