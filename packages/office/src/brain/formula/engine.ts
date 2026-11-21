import { FUNCTIONS } from "./functions/index.ts";
import { type Node, parseFormula } from "./parser.ts";
import {
  type Arg,
  type Cell,
  cellName,
  type FormulaFault,
  fault,
  isFault,
  toNumber,
  toText,
  type Value,
} from "./value.ts";

export type SheetCell =
  | string
  | number
  | boolean
  | null
  | { formula: string; cachedValue?: string | number | boolean };
export interface SheetInput {
  name: string;
  rows: SheetCell[][];
}

export interface FormulaResult {
  /** 能算出来才给缓存值；算不出来时由 Excel 打开后重算。 */
  value?: string | number | boolean;
  unsupported: boolean;
}

const LIMIT = 200_000;
const DEPTH = 100;

/** 只读工作簿视图：把公式单元格算出值，供写入时填缓存值与其它模块读取。 */
export class FormulaBook {
  private readonly sheets = new Map<string, Map<string, SheetCell>>();
  private readonly names = new Map<string, string>();
  private readonly values = new Map<string, Value>();
  private readonly busy = new Set<string>();
  private readonly unsupported = new Set<string>();
  /** 记在单元格上，别的公式用了未实现函数不应该连带把这一格标成未支持。 */
  private readonly unsupportedCells = new Set<string>();

  constructor(sheets: SheetInput[]) {
    for (const sheet of sheets) {
      const key = sheet.name.toLowerCase();
      this.names.set(key, sheet.name);
      const cells = new Map<string, SheetCell>();
      sheet.rows.forEach((row, rowIndex) => {
        row.forEach((cell, columnIndex) => {
          if (cell === null || cell === undefined) return;
          if (typeof cell === "object" && !("formula" in cell)) return;
          cells.set(`${rowIndex + 1}:${columnIndex + 1}`, cell);
        });
      });
      this.sheets.set(key, cells);
    }
  }

  /** 未列入的函数名，用于向调用方说明哪些单元格交给了 Excel。 */
  get unsupportedFunctions(): string[] {
    return [...this.unsupported].sort();
  }

  results(): Map<string, FormulaResult> {
    const output = new Map<string, FormulaResult>();
    for (const [sheetKey, cells] of this.sheets) {
      const name = this.names.get(sheetKey) ?? sheetKey;
      for (const key of cells.keys()) {
        const [row, column] = key.split(":").map(Number) as [number, number];
        const value = this.value(sheetKey, { column, row }, 0);
        const unsupported = this.unsupportedCells.has(`${sheetKey}!${key}`);
        output.set(`${name}!${cellName({ column, row })}`, {
          value:
            isFault(value) || value === null
              ? undefined
              : typeof value === "number" || typeof value === "string" || typeof value === "boolean"
                ? value
                : undefined,
          unsupported,
        });
      }
    }
    return output;
  }

  /** 单个单元格的值；给透视表读取区域用。 */
  cellValue(sheetName: string, column: number, row: number): string | number | boolean | null {
    const value = this.value(sheetName.toLowerCase(), { column, row }, 0);
    if (isFault(value) || value === null) return null;
    return typeof value === "boolean" || typeof value === "number" ? value : String(value);
  }

  private value(sheet: string, cell: Cell, depth: number): Value {
    const key = `${sheet}!${cell.row}:${cell.column}`;
    const cached = this.values.get(key);
    if (cached !== undefined) return cached;
    const input = this.sheets.get(sheet)?.get(`${cell.row}:${cell.column}`);
    if (input === undefined || input === null) return null;
    if (typeof input !== "object") return input;
    if (this.busy.has(key) || depth > DEPTH) return fault("#REF!");
    this.busy.add(key);
    const unsupported = this.unsupported.size;
    let result: Value;
    try {
      // 单元格里只可能是标量；区域结果按标量规则取唯一值，其余给 #VALUE!。
      result = scalarOf(this.node(parseFormula(input.formula), sheet, depth + 1));
    } catch {
      // 解析失败说明公式超出本地引擎的范围，保留用户给的缓存值。
      result = fault("#NAME?");
      this.unsupported.add("PARSE");
    } finally {
      this.busy.delete(key);
    }
    if (this.unsupported.size > unsupported) this.unsupportedCells.add(key);
    if (isFault(result) && input.cachedValue !== undefined) {
      this.values.set(key, input.cachedValue);
      return input.cachedValue;
    }
    if (!isFault(result)) this.values.set(key, result);
    return result;
  }

  private node(node: Node, sheet: string, depth: number): Arg {
    switch (node.t) {
      case "num":
      case "str":
      case "bool":
        return node.v;
      case "name":
        return fault("#NAME?");
      case "neg": {
        const value = toNumber(scalarOf(this.node(node.a, sheet, depth)));
        return isFault(value) ? value : -value;
      }
      case "pct": {
        const value = toNumber(scalarOf(this.node(node.a, sheet, depth)));
        return isFault(value) ? value : value / 100;
      }
      case "ref": {
        const target = node.sheet ? node.sheet.toLowerCase() : sheet;
        if (!this.sheets.has(target)) return fault("#REF!");
        if (!node.to) return this.value(target, node.from, depth);
        return this.range(target, node.from, node.to);
      }
      case "call": {
        const fn = FUNCTIONS[node.name];
        if (!fn) {
          this.unsupported.add(node.name);
          return fault("#NAME?");
        }
        return fn(node.args.map((arg) => this.node(arg, sheet, depth)));
      }
      case "bin":
        return binary(node.op, this.node(node.a, sheet, depth), this.node(node.b, sheet, depth));
    }
  }

  private range(sheet: string, from: Cell, to: Cell): Arg {
    const top = Math.min(from.row, to.row);
    const bottom = Math.max(from.row, to.row);
    const left = Math.min(from.column, to.column);
    const right = Math.max(from.column, to.column);
    if ((bottom - top + 1) * (right - left + 1) > LIMIT) return fault("#NUM!");
    const rows: Value[][] = [];
    for (let row = top; row <= bottom; row++) {
      const values: Value[] = [];
      for (let column = left; column <= right; column++)
        values.push(this.value(sheet, { column, row }, 0));
      rows.push(values);
    }
    return rows;
  }
}

function scalarOf(value: Arg): Value {
  if (!Array.isArray(value)) return value;
  if (value.length === 1 && value[0]?.length === 1) return value[0][0] ?? null;
  return fault("#VALUE!");
}

function binary(op: string, left: Arg, right: Arg): Value {
  if (op === "&") {
    const a = toText(scalarOf(left));
    if (isFault(a)) return a;
    const b = toText(scalarOf(right));
    return isFault(b) ? b : a + b;
  }
  if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
    const order = compare(scalarOf(left), scalarOf(right));
    if (isFault(order)) return order;
    switch (op) {
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
  }
  const a = toNumber(scalarOf(left));
  if (isFault(a)) return a;
  const b = toNumber(scalarOf(right));
  if (isFault(b)) return b;
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? fault("#DIV/0!") : a / b;
    default: {
      const result = a ** b;
      return Number.isFinite(result) ? result : fault("#NUM!");
    }
  }
}

function compare(left: Value, right: Value): number | FormulaFault {
  if (left instanceof Object && "code" in left) return left;
  if (right instanceof Object && "code" in right) return right;
  if (left === null && right === null) return 0;
  if (left === null) return rank(right) > 0 ? -1 : 1;
  if (right === null) return rank(left) > 0 ? 1 : -1;
  const leftRank = rank(left);
  const rightRank = rank(right);
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  if (typeof left === "number" && typeof right === "number")
    return left === right ? 0 : left < right ? -1 : 1;
  const a = String(left).toLowerCase();
  const b = String(right).toLowerCase();
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Excel 的比较顺序：数字 < 文本 < 逻辑值。 */
function rank(value: Value): number {
  if (typeof value === "number") return 0;
  if (typeof value === "string") return 1;
  return 2;
}
