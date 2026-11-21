import { type Cell, parseCell } from "./value.ts";

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "ref"; sheet?: string; from: Cell; to?: Cell }
  | { t: "name"; v: string }
  | { t: "call"; name: string; args: Node[] }
  | { t: "neg"; a: Node }
  | { t: "pct"; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node };

type Token =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "id"; v: string }
  | { k: "q"; v: string }
  | { k: "op"; v: string };

// 表名可以是中文，所以标识符要允许 Unicode 字母，不能只认 ASCII。
const IDENT = /^[$_\p{L}][$_\p{L}\p{N}.]*/u;
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/u;
const OPERATORS = [
  "<>",
  "<=",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "^",
  "&",
  "%",
  "(",
  ")",
  "!",
  ",",
  ":",
  "=",
  "<",
  ">",
];

/** 解析失败直接抛错；调用方把整条公式当作「无法计算」。 */
export function parseFormula(source: string): Node {
  return new Parser(tokenize(source.replace(/^_xlfn\./iu, ""))).expression();
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (/\s/u.test(char)) {
      index++;
      continue;
    }
    if (char === '"') {
      let value = "";
      index++;
      for (;;) {
        const next = source.indexOf('"', index);
        if (next < 0) throw new Error("formula_invalid");
        value += source.slice(index, next);
        index = next + 1;
        if (source[index] !== '"') break;
        value += '"';
        index++;
      }
      tokens.push({ k: "str", v: value });
      continue;
    }
    if (char === "'") {
      // 表名里的单引号成对出现（'It''s'!A1）；这里把它还原成真实名称。
      let value = "";
      index++;
      for (;;) {
        const next = source.indexOf("'", index);
        if (next < 0) throw new Error("formula_invalid");
        value += source.slice(index, next);
        index = next + 1;
        if (source[index] !== "'") break;
        value += "'";
        index++;
      }
      tokens.push({ k: "q", v: value });
      continue;
    }
    if (char === "#") {
      const match = /^#[A-Z0-9/!?]+/.exec(source.slice(index));
      if (!match) throw new Error("formula_invalid");
      tokens.push({ k: "id", v: match[0] });
      index += match[0].length;
      continue;
    }
    const number = NUMBER.exec(source.slice(index));
    if (number && !IDENT.test(source.slice(index))) {
      tokens.push({ k: "num", v: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const operator = OPERATORS.find((value) => source.startsWith(value, index));
    if (operator) {
      tokens.push({ k: "op", v: operator });
      index += operator.length;
      continue;
    }
    const identifier = IDENT.exec(source.slice(index));
    if (!identifier) throw new Error("formula_invalid");
    tokens.push({ k: "id", v: identifier[0] });
    index += identifier[0].length;
  }
  return tokens;
}

class Parser {
  private index = 0;
  // Explicit field: the office worker loads this file with Node's type stripping.
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0) {
    return this.tokens[this.index + offset];
  }
  private take() {
    const token = this.tokens[this.index++];
    if (!token) throw new Error("formula_invalid");
    return token;
  }
  private isOp(...values: string[]) {
    const token = this.peek();
    return token?.k === "op" && values.includes(token.v);
  }
  private expectOp(value: string) {
    if (!this.isOp(value)) throw new Error("formula_invalid");
    this.index++;
  }

  expression(): Node {
    const node = this.compare();
    if (this.index !== this.tokens.length) throw new Error("formula_invalid");
    return node;
  }
  private compare(): Node {
    let left = this.concat();
    while (this.isOp("=", "<>", "<", ">", "<=", ">=")) {
      const op = (this.take() as { v: string }).v;
      left = { t: "bin", op, a: left, b: this.concat() };
    }
    return left;
  }
  private concat(): Node {
    let left = this.additive();
    while (this.isOp("&")) {
      this.take();
      left = { t: "bin", op: "&", a: left, b: this.additive() };
    }
    return left;
  }
  private additive(): Node {
    let left = this.multiplicative();
    while (this.isOp("+", "-")) {
      const op = (this.take() as { v: string }).v;
      left = { t: "bin", op, a: left, b: this.multiplicative() };
    }
    return left;
  }
  private multiplicative(): Node {
    let left = this.power();
    while (this.isOp("*", "/")) {
      const op = (this.take() as { v: string }).v;
      left = { t: "bin", op, a: left, b: this.power() };
    }
    return left;
  }
  private power(): Node {
    const left = this.unary();
    if (!this.isOp("^")) return left;
    this.take();
    return { t: "bin", op: "^", a: left, b: this.power() };
  }
  private unary(): Node {
    if (this.isOp("-")) {
      this.take();
      return { t: "neg", a: this.unary() };
    }
    if (this.isOp("+")) {
      this.take();
      return this.unary();
    }
    return this.postfix();
  }
  private postfix(): Node {
    let node = this.primary();
    while (this.isOp("%")) {
      this.take();
      node = { t: "pct", a: node };
    }
    return node;
  }
  private primary(): Node {
    const token = this.take();
    if (token.k === "num") return { t: "num", v: token.v };
    if (token.k === "str") return { t: "str", v: token.v };
    if (token.k === "q") {
      if (!this.isOp("!")) throw new Error("formula_invalid");
      this.take();
      return this.reference(token.v);
    }
    if (token.k !== "id") throw new Error("formula_invalid");
    if (token.v === "(") throw new Error("formula_invalid");
    if (this.isOp("(")) {
      this.take();
      const args: Node[] = [];
      if (!this.isOp(")")) {
        for (;;) {
          args.push(this.compare());
          if (!this.isOp(",")) break;
          this.take();
        }
      }
      this.expectOp(")");
      return { t: "call", name: token.v.toUpperCase(), args };
    }
    if (this.isOp("!")) {
      this.take();
      return this.reference(token.v);
    }
    if (token.v.toUpperCase() === "TRUE") return { t: "bool", v: true };
    if (token.v.toUpperCase() === "FALSE") return { t: "bool", v: false };
    const cell = parseCell(token.v);
    if (!cell) return { t: "name", v: token.v };
    return { t: "ref", from: cell };
  }

  private reference(sheet: string): Node {
    const token = this.take();
    if (token.k !== "id") throw new Error("formula_invalid");
    const from = parseCell(token.v);
    if (!from) throw new Error("formula_invalid");
    if (!this.isOp(":")) return { t: "ref", sheet, from };
    this.take();
    const end = this.take();
    let endSheet: string | undefined;
    if (end.k === "id" && this.isOp("!")) {
      this.take();
      endSheet = end.v;
      const cellToken = this.take();
      if (cellToken.k !== "id") throw new Error("formula_invalid");
      const to = parseCell(cellToken.v);
      if (!to) throw new Error("formula_invalid");
      if (endSheet.toLowerCase() !== sheet.toLowerCase()) throw new Error("formula_invalid");
      return { t: "ref", sheet, from, to };
    }
    if (end.k !== "id") throw new Error("formula_invalid");
    const to = parseCell(end.v);
    if (!to) throw new Error("formula_invalid");
    return { t: "ref", sheet, from, to };
  }
}
