import { matrix, num, scalar } from "../common.ts";
import { type FormulaFunction, fault, isFault, toText, type Value } from "../value.ts";

function same(left: Value, right: Value) {
  if (isFault(left) || isFault(right)) return false;
  if (left === null || right === null) return left === right;
  if (typeof left === "number" && typeof right === "number") return left === right;
  const leftText = toText(left);
  const rightText = toText(right);
  if (isFault(leftText) || isFault(rightText)) return false;
  return leftText.toLowerCase() === rightText.toLowerCase();
}

function wildcardMatch(value: Value, pattern: Value) {
  if (typeof pattern !== "string") return same(value, pattern);
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  const text = toText(value);
  return typeof text === "string" && new RegExp(`^${source}$`, "iu").test(text);
}

function index(array: Value[][], row: number, column: number): Value {
  return array[row]?.[column] ?? fault("#REF!");
}

export const lookupFunctions: Record<string, FormulaFunction> = {
  VLOOKUP: (args) => {
    const target = scalar(args[0] ?? null);
    const table = matrix(args[1] ?? null);
    if (isFault(table)) return table;
    const column = num(args[2] ?? null);
    if (isFault(column)) return column;
    const approximate = args[3] === undefined ? true : Boolean(args[3]);
    const width = table[0]?.length ?? 0;
    if (column < 1 || column > width) return fault("#REF!");
    if (!approximate) {
      const row = table.findIndex((values) => same(values[0] ?? null, target));
      return row < 0 ? fault("#N/A") : index(table, row, column - 1);
    }
    let found = -1;
    for (let row = 0; row < table.length; row++) {
      const value = table[row]?.[0];
      if (typeof value === "number" && typeof target === "number" && value <= target) found = row;
    }
    return found < 0 ? fault("#N/A") : index(table, found, column - 1);
  },
  HLOOKUP: (args) => {
    const target = scalar(args[0] ?? null);
    const table = matrix(args[1] ?? null);
    if (isFault(table)) return table;
    const row = num(args[2] ?? null);
    if (isFault(row)) return row;
    const approximate = args[3] === undefined ? true : Boolean(args[3]);
    if (row < 1 || row > table.length) return fault("#REF!");
    const header = table[0] ?? [];
    if (!approximate) {
      const column = header.findIndex((value) => same(value, target));
      return column < 0 ? fault("#N/A") : index(table, row - 1, column);
    }
    let found = -1;
    for (let column = 0; column < header.length; column++) {
      const value = header[column];
      if (typeof value === "number" && typeof target === "number" && value <= target)
        found = column;
    }
    return found < 0 ? fault("#N/A") : index(table, row - 1, found);
  },
  LOOKUP: (args) => {
    const target = scalar(args[0] ?? null);
    const lookup = matrix(args[1] ?? null);
    if (isFault(lookup)) return lookup;
    const result = args[2] === undefined ? lookup : matrix(args[2]);
    if (isFault(result)) return result;
    const vector = lookup.map((values) => values[0] ?? null);
    let found = -1;
    for (let index = 0; index < vector.length; index++) {
      const value = vector[index];
      if (typeof value === "number" && typeof target === "number" && value <= target) found = index;
    }
    return found < 0 ? fault("#N/A") : (result[found]?.[0] ?? fault("#REF!"));
  },
  INDEX: (args) => {
    const array = matrix(args[0] ?? null);
    if (isFault(array)) return array;
    const row = num(args[1] ?? null);
    if (isFault(row)) return row;
    const column = args[2] === undefined ? 1 : num(args[2]);
    if (isFault(column)) return column;
    if (row < 1 || column < 1) return fault("#VALUE!");
    return index(array, Math.trunc(row) - 1, Math.trunc(column) - 1);
  },
  MATCH: (args) => {
    const target = scalar(args[0] ?? null);
    const array = matrix(args[1] ?? null);
    if (isFault(array)) return array;
    const type = args[2] === undefined ? 1 : num(args[2]);
    if (isFault(type)) return type;
    const values = array.map((row) => row[0] ?? null);
    if (type === 0) {
      const found = values.findIndex((value) => wildcardMatch(value, target));
      return found < 0 ? fault("#N/A") : found + 1;
    }
    let found = -1;
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (typeof value !== "number" || typeof target !== "number") continue;
      if (type > 0 && value <= target) found = index;
      if (type < 0 && value >= target) found = index;
    }
    return found < 0 ? fault("#N/A") : found + 1;
  },
  XLOOKUP: (args) => {
    const target = scalar(args[0] ?? null);
    const lookup = matrix(args[1] ?? null);
    if (isFault(lookup)) return lookup;
    const result = matrix(args[2] ?? null);
    if (isFault(result)) return result;
    const fallback = args[3] === undefined ? fault("#N/A") : scalar(args[3]);
    const mode = args[4] === undefined ? 0 : num(args[4]);
    if (isFault(mode)) return mode;
    const reverse = args[5] !== undefined && Number(args[5]) === -1;
    const vector = lookup.map((row) => row[0] ?? null);
    if (mode === 0 || mode === 2) {
      const found = vector.findIndex((value) =>
        mode === 2 ? wildcardMatch(value, target) : same(value, target),
      );
      return found < 0 ? fallback : (result[found]?.[0] ?? fault("#REF!"));
    }
    let found = -1;
    for (let index = 0; index < vector.length; index++) {
      const value = vector[index];
      if (typeof value !== "number" || typeof target !== "number") continue;
      const better =
        mode > 0
          ? value >= target && (found < 0 || value < (vector[found] as number))
          : value <= target && (found < 0 || value > (vector[found] as number));
      if (better) found = index;
    }
    if (found < 0) return fallback;
    if (reverse) {
      const targetIndex = found;
      for (let index = vector.length - 1; index >= 0; index--)
        if (same(vector[index] ?? null, vector[targetIndex] ?? null))
          return result[index]?.[0] ?? fault("#REF!");
    }
    return result[found]?.[0] ?? fault("#REF!");
  },
  CHOOSE: (args) => {
    const position = num(args[0] ?? null);
    if (isFault(position)) return position;
    if (position < 1 || position > args.length - 1) return fault("#VALUE!");
    return scalar(args[Math.trunc(position)] ?? null);
  },
};

export type { Value };
