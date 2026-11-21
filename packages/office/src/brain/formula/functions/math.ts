import { criteriaMatcher, matrix, num, numbers, scalar } from "../common.ts";
import {
  type Arg,
  type FormulaFault,
  type FormulaFunction,
  fault,
  isFault,
  type Value,
} from "../value.ts";

function round(value: number, digits: number, mode: "round" | "up" | "down") {
  const factor = 10 ** Math.trunc(digits);
  const scaled = value * factor;
  const rounded =
    mode === "round"
      ? Math.round(scaled + (scaled >= 0 ? Number.EPSILON : -Number.EPSILON))
      : mode === "up"
        ? scaled >= 0
          ? Math.ceil(scaled)
          : Math.floor(scaled)
        : scaled >= 0
          ? Math.floor(scaled)
          : Math.ceil(scaled);
  return rounded / factor;
}

function requireNumbers(args: Arg[]): number[] | FormulaFault {
  return numbers(args);
}

function aggregate(args: Arg[], reduce: (values: number[]) => number) {
  const values = requireNumbers(args);
  return isFault(values) ? values : reduce(values);
}

/** 条件函数按行对齐：每对 (区域, 条件) 只看该行的第一个值。 */
function pairArgs(args: Arg[]) {
  const pairs: { values: Value[][]; test: (value: Value) => boolean }[] = [];
  for (let index = 0; index + 1 < args.length; index += 2) {
    const values = matrix(args[index] as Arg);
    if (isFault(values)) return values;
    pairs.push({ values, test: criteriaMatcher(scalar(args[index + 1] as Arg)) });
  }
  return pairs;
}

function selected(
  sum: Value[][],
  pairs: { values: Value[][]; test: (value: Value) => boolean }[],
  reduce: (values: number[]) => number,
) {
  const values: number[] = [];
  for (let row = 0; row < sum.length; row++) {
    if (!pairs.every((pair) => pair.test(pair.values[row]?.[0] ?? null))) continue;
    const value = sum[row]?.[0];
    if (typeof value === "number") values.push(value);
  }
  return values.length ? reduce(values) : fault("#DIV/0!");
}

export const mathFunctions: Record<string, FormulaFunction> = {
  SUM: (args) => aggregate(args, (values) => values.reduce((total, value) => total + value, 0)),
  AVERAGE: (args) =>
    aggregate(args, (values) =>
      values.length
        ? values.reduce((total, value) => total + value, 0) / values.length
        : Number.NaN,
    ),
  MIN: (args) => aggregate(args, (values) => (values.length ? Math.min(...values) : 0)),
  MAX: (args) => aggregate(args, (values) => (values.length ? Math.max(...values) : 0)),
  COUNT: (args) => {
    let count = 0;
    for (const arg of args) {
      const direct = !Array.isArray(arg);
      for (const value of Array.isArray(arg) ? arg.flat() : [arg]) {
        if (typeof value === "number") count++;
        else if (direct && typeof value === "string" && value.trim() !== "") {
          const parsed = num(value);
          if (!isFault(parsed)) count++;
        }
      }
    }
    return count;
  },
  COUNTA: (args) => {
    let count = 0;
    for (const arg of args)
      for (const value of Array.isArray(arg) ? arg.flat() : [arg])
        if (value !== null && value !== "") count++;
    return count;
  },
  COUNTBLANK: (args) => {
    let count = 0;
    for (const arg of args)
      for (const value of Array.isArray(arg) ? arg.flat() : [arg])
        if (value === null || value === "") count++;
    return count;
  },
  COUNTIF: (args) => {
    const values = matrix(args[0] ?? null);
    if (isFault(values)) return values;
    const test = criteriaMatcher(scalar(args[1] ?? null));
    let count = 0;
    for (const value of values.flat()) if (test(value)) count++;
    return count;
  },
  COUNTIFS: (args) => {
    const pairs = pairArgs(args);
    if (isFault(pairs)) return pairs;
    const rows = pairs[0]?.values.length ?? 0;
    let count = 0;
    for (let row = 0; row < rows; row++)
      if (pairs.every((pair) => pair.test(pair.values[row]?.[0] ?? null))) count++;
    return count;
  },
  SUMIF: (args) => {
    const values = matrix(args[0] ?? null);
    if (isFault(values)) return values;
    const test = criteriaMatcher(scalar(args[1] ?? null));
    const sums = args[2] === undefined ? values : matrix(args[2]);
    if (isFault(sums)) return sums;
    let total = 0;
    for (let row = 0; row < values.length; row++) {
      if (!test(values[row]?.[0] ?? null)) continue;
      const value = sums[row]?.[0];
      if (typeof value === "number") total += value;
    }
    return total;
  },
  SUMIFS: (args) => {
    const sums = matrix(args[0] ?? null);
    if (isFault(sums)) return sums;
    const pairs = pairArgs(args.slice(1));
    if (isFault(pairs)) return pairs;
    let total = 0;
    for (let row = 0; row < sums.length; row++) {
      if (!pairs.every((pair) => pair.test(pair.values[row]?.[0] ?? null))) continue;
      const value = sums[row]?.[0];
      if (typeof value === "number") total += value;
    }
    return total;
  },
  AVERAGEIF: (args) => {
    const values = matrix(args[0] ?? null);
    if (isFault(values)) return values;
    const test = criteriaMatcher(scalar(args[1] ?? null));
    const sums = args[2] === undefined ? values : matrix(args[2]);
    if (isFault(sums)) return sums;
    const picked: number[] = [];
    for (let row = 0; row < values.length; row++) {
      if (!test(values[row]?.[0] ?? null)) continue;
      const value = sums[row]?.[0];
      if (typeof value === "number") picked.push(value);
    }
    return picked.length
      ? picked.reduce((total, value) => total + value, 0) / picked.length
      : fault("#DIV/0!");
  },
  AVERAGEIFS: (args) => {
    const sums = matrix(args[0] ?? null);
    if (isFault(sums)) return sums;
    const pairs = pairArgs(args.slice(1));
    if (isFault(pairs)) return pairs;
    return selected(
      sums,
      pairs,
      (picked) => picked.reduce((total, value) => total + value, 0) / picked.length,
    );
  },
  MAXIFS: (args) => {
    const sums = matrix(args[0] ?? null);
    if (isFault(sums)) return sums;
    const pairs = pairArgs(args.slice(1));
    if (isFault(pairs)) return pairs;
    return selected(sums, pairs, (picked) => Math.max(...picked));
  },
  MINIFS: (args) => {
    const sums = matrix(args[0] ?? null);
    if (isFault(sums)) return sums;
    const pairs = pairArgs(args.slice(1));
    if (isFault(pairs)) return pairs;
    return selected(sums, pairs, (picked) => Math.min(...picked));
  },
  SUMPRODUCT: (args) => {
    const arrays: Value[][][] = [];
    for (const arg of args) {
      const values = matrix(arg);
      if (isFault(values)) return values;
      arrays.push(values);
    }
    if (arrays.length === 0) return fault("#VALUE!");
    const rows = arrays[0]?.length ?? 0;
    let total = 0;
    for (let row = 0; row < rows; row++) {
      const columns = arrays[0]?.[row]?.length ?? 0;
      for (let column = 0; column < columns; column++) {
        let product = 1;
        for (const array of arrays) {
          const value = array[row]?.[column] ?? null;
          if (typeof value !== "number") {
            product = 0;
            break;
          }
          product *= value;
        }
        total += product;
      }
    }
    return total;
  },
  ROUND: (args) => {
    const value = num(args[0] ?? null);
    if (isFault(value)) return value;
    const digits = args[1] === undefined ? 0 : num(args[1]);
    if (isFault(digits)) return digits;
    return round(value, digits, "round");
  },
  ROUNDUP: (args) => {
    const value = num(args[0] ?? null);
    if (isFault(value)) return value;
    const digits = args[1] === undefined ? 0 : num(args[1]);
    if (isFault(digits)) return digits;
    return round(value, digits, "up");
  },
  ROUNDDOWN: (args) => {
    const value = num(args[0] ?? null);
    if (isFault(value)) return value;
    const digits = args[1] === undefined ? 0 : num(args[1]);
    if (isFault(digits)) return digits;
    return round(value, digits, "down");
  },
  INT: (args) => {
    const value = num(args[0] ?? null);
    return isFault(value) ? value : Math.floor(value);
  },
  ABS: (args) => {
    const value = num(args[0] ?? null);
    return isFault(value) ? value : Math.abs(value);
  },
  MOD: (args) => {
    const value = num(args[0] ?? null);
    if (isFault(value)) return value;
    const divisor = num(args[1] ?? null);
    if (isFault(divisor)) return divisor;
    return divisor === 0 ? fault("#DIV/0!") : value - divisor * Math.floor(value / divisor);
  },
  POWER: (args) => {
    const base = num(args[0] ?? null);
    if (isFault(base)) return base;
    const exponent = num(args[1] ?? null);
    if (isFault(exponent)) return exponent;
    const result = base ** exponent;
    return Number.isFinite(result) ? result : fault("#NUM!");
  },
  SQRT: (args) => {
    const value = num(args[0] ?? null);
    if (isFault(value)) return value;
    return value < 0 ? fault("#NUM!") : Math.sqrt(value);
  },
  EXP: (args) => {
    const value = num(args[0] ?? null);
    return isFault(value) ? value : Math.exp(value);
  },
  LN: (args) => {
    const value = num(args[0] ?? null);
    if (isFault(value)) return value;
    return value <= 0 ? fault("#NUM!") : Math.log(value);
  },
  LOG: (args) => {
    const value = num(args[0] ?? null);
    if (isFault(value)) return value;
    const base = args[1] === undefined ? 10 : num(args[1]);
    if (isFault(base)) return base;
    return value <= 0 || base <= 0 ? fault("#NUM!") : Math.log(value) / Math.log(base);
  },
  LOG10: (args) => {
    const value = num(args[0] ?? null);
    if (isFault(value)) return value;
    return value <= 0 ? fault("#NUM!") : Math.log10(value);
  },
  CEILING: (args) => {
    const value = num(args[0] ?? null);
    if (isFault(value)) return value;
    const significance = args[1] === undefined ? 1 : num(args[1]);
    if (isFault(significance)) return significance;
    if (significance === 0) return 0;
    return value >= 0
      ? Math.ceil(value / significance) * significance
      : -Math.floor(-value / significance) * significance;
  },
  FLOOR: (args) => {
    const value = num(args[0] ?? null);
    if (isFault(value)) return value;
    const significance = args[1] === undefined ? 1 : num(args[1]);
    if (isFault(significance)) return significance;
    if (significance === 0) return 0;
    return value >= 0
      ? Math.floor(value / significance) * significance
      : -Math.ceil(-value / significance) * significance;
  },
  TRUNC: (args) => {
    const value = num(args[0] ?? null);
    if (isFault(value)) return value;
    const digits = args[1] === undefined ? 0 : num(args[1]);
    if (isFault(digits)) return digits;
    const factor = 10 ** Math.trunc(digits);
    return Math.trunc(value * factor) / factor;
  },
  SIGN: (args) => {
    const value = num(args[0] ?? null);
    return isFault(value) ? value : Math.sign(value);
  },
  PI: () => Math.PI,
  MEDIAN: (args) => {
    const values = requireNumbers(args);
    if (isFault(values)) return values;
    if (!values.length) return fault("#NUM!");
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  },
  LARGE: (args) => rankValue(args, true),
  SMALL: (args) => rankValue(args, false),
  RANK: (args) => {
    const value = num(args[0] ?? null);
    if (isFault(value)) return value;
    const values = requireNumbers([args[1] ?? null]);
    if (isFault(values)) return values;
    const order = args[2] === undefined ? 0 : num(args[2]);
    if (isFault(order)) return order;
    const sorted = [...values].sort((a, b) => (order ? a - b : b - a));
    const index = sorted.indexOf(value);
    return index < 0 ? fault("#N/A") : index + 1;
  },
  PERCENTILE: (args) => {
    const values = requireNumbers([args[0] ?? null]);
    if (isFault(values)) return values;
    const fraction = num(args[1] ?? null);
    if (isFault(fraction)) return fraction;
    if (!values.length || fraction < 0 || fraction > 1) return fault("#NUM!");
    const sorted = [...values].sort((a, b) => a - b);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return (
      (sorted[lower] as number) +
      ((sorted[upper] as number) - (sorted[lower] as number)) * (position - lower)
    );
  },
  STDEV: (args) => deviation(args, true, false),
  STDEVP: (args) => deviation(args, false, false),
  VAR: (args) => deviation(args, true, true),
  VARP: (args) => deviation(args, false, true),
};

function rankValue(args: Arg[], largest: boolean) {
  const values = requireNumbers([args[0] ?? null]);
  if (isFault(values)) return values;
  const position = num(args[1] ?? null);
  if (isFault(position)) return position;
  if (!values.length || position < 1 || position > values.length) return fault("#NUM!");
  const sorted = [...values].sort((a, b) => a - b);
  return largest
    ? (sorted[sorted.length - Math.trunc(position)] as number)
    : (sorted[Math.trunc(position) - 1] as number);
}

function deviation(args: Arg[], sample: boolean, variance: boolean) {
  const values = requireNumbers(args);
  if (isFault(values)) return values;
  if (values.length <= (sample ? 1 : 0)) return fault("#DIV/0!");
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const total = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const result = total / (values.length - (sample ? 1 : 0));
  return variance ? result : Math.sqrt(result);
}
