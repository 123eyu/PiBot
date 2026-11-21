/**
 * Format-independent template syntax. Kept separate from the OOXML adapters so Word, PPT
 * and Excel agree on what a field, condition or loop means; document formats only decide where the
 * text lives. Expressions read data and compare it; nothing is evaluated as code.
 */
import type { TemplateBudget } from "./budget.ts";

export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | TemplateValue[]
  | { [key: string]: TemplateValue };

export type TemplateFieldKind = "value" | "condition" | "list";

export interface TemplateField {
  path: string;
  kinds: TemplateFieldKind[];
  count: number;
  /** Format-specific places the field appears in, e.g. `word:body`, `ppt:slide3`, `sheet:Sheet1!A1`. */
  scopes: string[];
}

export type TemplateExpression = {
  path: string;
  op?: "==" | "!=" | ">" | "<" | ">=" | "<=";
  literal?: string | number | boolean | null;
};

export type TemplateNode =
  | { kind: "text"; value: string }
  | { kind: "field"; path: string }
  | {
      kind: "if";
      expression: TemplateExpression;
      consequent: TemplateNode[];
      otherwise: TemplateNode[];
    }
  | { kind: "each"; path: string; body: TemplateNode[] };

export interface ParsedTemplate {
  nodes: TemplateNode[];
  fields: TemplateField[];
}

export interface TemplateScope {
  value: TemplateValue;
  index?: number;
  count?: number;
}

const TAG = /\{\{([^{}]*)\}\}/gu;
const PATH = /^(?:@index|@number|\.|this|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/u;
const OPERATOR = /\s*(==|!=|>=|<=|>|<)\s*/u;

interface OpenBlock {
  node: Extract<TemplateNode, { kind: "if" } | { kind: "each" }>;
  parent: TemplateNode[];
}

/** Parses one piece of document text; malformed tags stay literal so ordinary braces survive. */
export function parseTemplate(text: string, budget: TemplateBudget): ParsedTemplate {
  const fields = new Map<string, TemplateField>();
  const note = (path: string, kind: TemplateFieldKind) => {
    const field = fields.get(path) ?? { path, kinds: [], count: 0, scopes: [] };
    if (!field.kinds.includes(kind)) field.kinds.push(kind);
    field.count++;
    fields.set(path, field);
  };
  const root: TemplateNode[] = [];
  let current = root;
  const push = (node: TemplateNode) => {
    budget.parse();
    current.push(node);
  };
  const stack: OpenBlock[] = [];
  let last = 0;
  for (const match of text.matchAll(TAG)) {
    const index = match.index ?? 0;
    if (index > last) push({ kind: "text", value: text.slice(last, index) });
    last = index + match[0].length;
    const tag = (match[1] ?? "").trim();
    if (tag.startsWith("#if")) {
      const expression = parseExpression(tag.slice(3).trim());
      if (!expression) {
        push({ kind: "text", value: match[0] });
        continue;
      }
      note(expression.path, "condition");
      // Named `consequent`, not `then`: a `then` field makes the node look like a promise.
      const node = { kind: "if" as const, expression, consequent: [], otherwise: [] };
      budget.depth(stack.length + 1);
      push(node);
      stack.push({ node, parent: current });
      current = node.consequent;
      continue;
    }
    if (tag.startsWith("#each")) {
      const path = tag.slice(5).trim();
      if (!PATH.test(path) || path === "." || path === "this") {
        push({ kind: "text", value: match[0] });
        continue;
      }
      note(path, "list");
      const node = { kind: "each" as const, path, body: [] };
      budget.depth(stack.length + 1);
      push(node);
      stack.push({ node, parent: current });
      current = node.body;
      continue;
    }
    if (tag === "else" || tag === "/if" || tag === "/each") {
      const open = stack.at(-1);
      const expected = tag === "else" ? "if" : tag.slice(1);
      if (!open || open.node.kind !== expected) {
        push({ kind: "text", value: match[0] });
        continue;
      }
      if (tag === "else" && open.node.kind === "if") current = open.node.otherwise;
      else {
        stack.pop();
        current = open.parent;
      }
      continue;
    }
    if (!PATH.test(tag)) {
      push({ kind: "text", value: match[0] });
      continue;
    }
    note(tag, "value");
    push({ kind: "field", path: tag });
  }
  if (last < text.length) push({ kind: "text", value: text.slice(last) });
  return { nodes: root, fields: [...fields.values()] };
}

/** Adds the place a field was found to a parsed template's field list. */
export function addScope(fields: TemplateField[], scope: string) {
  for (const field of fields) if (!field.scopes.includes(scope)) field.scopes.push(scope);
}

/** `{{#if path}}`, `{{#if path != "x"}}`; unknown syntax is not a condition. */
function parseExpression(text: string): TemplateExpression | undefined {
  const match = OPERATOR.exec(text);
  const path = (match ? text.slice(0, match.index) : text).trim();
  if (!PATH.test(path) || path === "." || path === "this" || path === "@index") return undefined;
  if (!match) return { path };
  const literal = parseLiteral(text.slice(match.index + match[0].length).trim());
  if (literal === undefined) return undefined;
  return { path, op: match[1] as TemplateExpression["op"], literal };
}

function parseLiteral(text: string): string | number | boolean | null | undefined {
  if (/^-?\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  if (/^"(?:[^"\\]|\\.)*"$/u.test(text) || /^'(?:[^'\\]|\\.)*'$/u.test(text))
    return text.slice(1, -1).replaceAll(/\\(.)/gu, "$1");
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  return undefined;
}

const isObject = (value: TemplateValue): value is { [key: string]: TemplateValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Inner scopes win: `{{name}}` inside `{{#each people}}` is the item's name, then the root's. */
function lookup(path: string, scopes: readonly TemplateScope[]): TemplateValue {
  if (path === "." || path === "this") return scopes.at(-1)?.value;
  if (path === "@index") return scopes.at(-1)?.index ?? 0;
  if (path === "@number") return (scopes.at(-1)?.index ?? 0) + 1;
  const [first, ...rest] = path.split(".");
  for (const scope of [...scopes].reverse()) {
    const holder = scope.value;
    if (!isObject(holder) || !Object.hasOwn(holder, first as string)) continue;
    let value = holder[first as string];
    for (const key of rest) {
      if (!isObject(value) || !Object.hasOwn(value, key)) return undefined;
      value = value[key];
    }
    return value;
  }
  return undefined;
}

/** Resolves a loop path against the root data, for adapters that repeat structural elements. */
export function resolvePath(path: string, data: TemplateValue): TemplateValue {
  return lookup(path, [{ value: data }]);
}

/** Loop items as the engine iterates them: arrays expand, a single object repeats once. */
export function resolveItems(path: string, data: TemplateValue): TemplateValue[] {
  return loopItems(resolvePath(path, data));
}

function loopItems(value: TemplateValue): TemplateValue[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || typeof value === "boolean") return [];
  return [value];
}

function truthy(value: TemplateValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== false && value !== "" && value !== 0;
}

function numeric(value: TemplateValue) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

function compare(
  left: TemplateValue,
  op: TemplateExpression["op"],
  right: TemplateValue,
  budget: TemplateBudget,
) {
  if (op === "==" || op === "!=") {
    const [a, b] = [numeric(left), numeric(right)];
    const equal =
      a !== undefined && b !== undefined
        ? a === b
        : valueText(left, budget) === valueText(right, budget);
    return op === "==" ? equal : !equal;
  }
  const [a, b] = [numeric(left), numeric(right)];
  if (a === undefined || b === undefined) return false;
  if (op === ">") return a > b;
  if (op === "<") return a < b;
  if (op === ">=") return a >= b;
  return a <= b;
}

function valueText(value: TemplateValue, budget: TemplateBudget): string {
  const parts: string[] = [];
  const append = (part: string) => {
    budget.expand(0, part.length);
    parts.push(part);
  };
  const visit = (item: TemplateValue, depth: number) => {
    budget.depth(depth);
    if (Array.isArray(item)) {
      budget.expand(item.length);
      for (const [index, child] of item.entries()) {
        if (index) append(", ");
        visit(child, depth + 1);
      }
    } else if (item !== undefined && item !== null && !isObject(item)) append(String(item));
  };
  visit(value, 0);
  return parts.join("");
}

/** Reserve each branch/iteration before expanding it, and join only bounded fragments. */
export function renderTemplate(
  nodes: readonly TemplateNode[],
  data: TemplateValue,
  budget: TemplateBudget,
  scopes: TemplateScope[] = [{ value: data }],
): string {
  const out: string[] = [];
  const visit = (
    list: readonly TemplateNode[],
    current: TemplateScope[],
    depth: number,
    reserved = false,
  ) => {
    budget.depth(depth);
    if (!reserved) budget.expand(list.length);
    for (const node of list) {
      if (node.kind === "text") {
        budget.expand(0, node.value.length);
        out.push(node.value);
      } else if (node.kind === "field") out.push(valueText(lookup(node.path, current), budget));
      else if (node.kind === "if") {
        const { path, op, literal } = node.expression;
        const value = lookup(path, current);
        const keep = op ? compare(value, op, literal ?? null, budget) : truthy(value);
        visit(keep ? node.consequent : node.otherwise, current, depth + 1);
      } else {
        const items = loopItems(lookup(node.path, current));
        budget.expand(items.length * (1 + node.body.length));
        for (const [index, item] of items.entries())
          visit(
            node.body,
            [...current, { value: item, index, count: items.length }],
            depth + 1,
            true,
          );
      }
    }
  };
  visit(nodes, scopes, scopes.length - 1);
  return out.join("");
}

/** True when the source has no construct that needs data, so callers can skip rewriting it. */
export function isTemplate(source: string) {
  return source.includes("{{");
}

/** Exact standalone block tag, e.g. a Word paragraph or a table cell that only holds the loop. */
export function blockTag(
  source: string,
): { kind: "start" | "end" | "else"; tag: string } | undefined {
  const trimmed = source.trim();
  const match = /^\{\{\s*(\/(?:if|each)|#(?:if|each)\b[^{}]*|else)\s*\}\}$/u.exec(trimmed);
  if (!match) return undefined;
  const tag = match[1] as string;
  return { kind: tag.startsWith("/") ? "end" : tag === "else" ? "else" : "start", tag };
}

/** Reads a loop path out of a standalone `{{#each path}}` tag. */
export function eachPath(tag: string) {
  const path = tag.trim().slice(5).trim();
  return PATH.test(path) && path !== "." && path !== "this" ? path : undefined;
}
