import type { OfficePackage } from "../ooxml/package.ts";
import { DOC_REL } from "../ooxml/package.ts";
import { type Element, parsePart } from "../ooxml/xml.ts";
import type { TemplateBudget } from "./budget.ts";
import {
  addScope,
  blockTag,
  eachPath,
  parseTemplate,
  renderTemplate,
  resolveItems,
  type TemplateField,
  type TemplateScope,
  type TemplateValue,
} from "./engine.ts";
import { applyRowShift, type RowShift } from "./excel-ranges.ts";
import { applyEdits, attribute, escapeText, find } from "./xml-text.ts";

export interface ExcelTemplateStats {
  fields: TemplateField[];
  warnings: string[];
  replacements: number;
  loops: number;
  /** Rows produced by `{{#each}}` in a sheet, including the template row itself. */
  rows: number;
}

type Edit = { start: number; end: number; value: string };
type Cell = { node: Element; text: string; reference: string };

const SHARED = "xl/sharedStrings.xml";

export function sheetParts(pkg: OfficePackage) {
  const main = pkg.mainPart();
  const rels = pkg.relationships(main);
  const sheets: { part: string; name: string }[] = [];
  for (const node of find(pkg.xml(main).root, "sheet")) {
    const id = attribute(node, "id", DOC_REL);
    const target = rels.find((rel) => rel.id === id)?.target;
    if (target) sheets.push({ part: target, name: node.attrs.get("name") ?? target });
  }
  return sheets;
}

function sharedStrings(pkg: OfficePackage) {
  const bytes = pkg.readPart(SHARED);
  if (!bytes) return [];
  const parsed = pkg.xml(SHARED);
  return find(parsed.root, "si").map((item) =>
    find(item, "t")
      .map((text) => parsed.source.slice(text.openEnd, text.closeStart))
      .join(""),
  );
}

function cellText(parsed: ReturnType<typeof parsePart>, cell: Element, shared: readonly string[]) {
  const type = cell.attrs.get("t") ?? "n";
  const value = find(cell, "v")[0];
  const raw = value ? parsed.source.slice(value.openEnd, value.closeStart) : "";
  if (type === "s") return shared[Number(raw)] ?? "";
  if (type === "inlineStr")
    return find(cell, "t")
      .map((text) => parsed.source.slice(text.openEnd, text.closeStart))
      .join("");
  return raw;
}

function cells(
  parsed: ReturnType<typeof parsePart>,
  row: Element,
  shared: readonly string[],
): Cell[] {
  return find(row, "c").map((node) => ({
    node,
    text: cellText(parsed, node, shared),
    reference: node.attrs.get("r") ?? "",
  }));
}

function columnOf(reference: string) {
  return /^[A-Z]+/u.exec(reference)?.[0] ?? "A";
}

/** Shifts only relative row references; absolute ones ($5) and whole-column ranges stay put. */
function shiftFormula(formula: string, delta: number) {
  if (!delta) return formula;
  return formula
    .split('"')
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(
            /(\$?[A-Z]{1,3})(\$?)(\d+)/gu,
            (match, letters: string, absolute: string, digits: string) =>
              absolute ? match : `${letters}${Number(digits) + delta}`,
          ),
    )
    .join('"');
}

function renumber(source: string, element: Element, row: number) {
  let xml = source.slice(element.start, element.end);
  const base = element.start;
  const edits: Edit[] = [];
  for (const cell of find(element, "c")) {
    const reference = cell.attrs.get("r");
    if (reference)
      edits.push({
        start: cell.start - base,
        end: cell.openEnd - base,
        value: source
          .slice(cell.start, cell.openEnd)
          .replace(/r="[A-Z]+\d+"/u, `r="${columnOf(reference)}${row}"`),
      });
  }
  const rowTag = source.slice(element.start, element.openEnd).replace(/r="\d+"/u, `r="${row}"`);
  edits.push({ start: 0, end: element.openEnd - base, value: rowTag });
  xml = applyEdits(xml, edits);
  return xml;
}

/** Rewrites a rebuilt row's own references; cells were already replaced, so this cannot reuse `renumber`. */
function renumberXml(xml: string, row: number, delta: number) {
  const tagged = xml
    .replace(
      /(<row\b[^>]*\sr=")(\d+)(")/u,
      (_match, head: string, _old, tail: string) => `${head}${row}${tail}`,
    )
    .replace(
      /(<c\b[^>]*\sr=")([A-Z]+)\d+(")/gu,
      (_match, head: string, column: string, tail: string) => `${head}${column}${row}${tail}`,
    );
  if (!delta) return tagged;
  return tagged.replace(
    /(<f[^>]*>)([\s\S]*?)(<\/f>)/gu,
    (_match, open: string, body: string, close: string) =>
      `${open}${shiftFormula(body, delta)}${close}`,
  );
}

function cellXml(source: string, cell: Element, value: string) {
  const open = source
    .slice(cell.start, cell.openEnd)
    .replace(/\st="[^"]*"/gu, "")
    .replace(/\s*\/>$/u, ">");
  // `closeStart` is the only reliable place to resume: the body already sits between the
  // open and close tags, so slicing from `openEnd` would duplicate it and drop `</c>`.
  const close = source.slice(cell.closeStart, cell.end);
  const numeric = /^-?\d+(?:\.\d+)?$/u.test(value.trim());
  // A value that came in as a number stays a number so formulas keep working; anything else is
  // written as an inline string, because editing a shared string would affect other cells.
  const type = numeric ? "" : ' t="inlineStr"';
  const body = numeric
    ? `<v>${value.trim()}</v>`
    : value
      ? `<is><t xml:space="preserve">${escapeText(value)}</t></is>`
      : "";
  return {
    start: cell.start,
    end: cell.end,
    value: `${open.replace(/>$/u, `${type}>`)}${body}${close}`,
  };
}

export function excelFields(pkg: OfficePackage, budget: TemplateBudget): ExcelTemplateStats {
  const stats: ExcelTemplateStats = {
    fields: [],
    warnings: [],
    replacements: 0,
    loops: 0,
    rows: 0,
  };
  const shared = sharedStrings(pkg);
  for (const sheet of sheetParts(pkg)) {
    const parsed = pkg.xml(sheet.part);
    for (const row of find(parsed.root, "row"))
      for (const cell of cells(parsed, row, shared))
        if (cell.text.includes("{{")) {
          const fields = parseTemplate(cell.text, budget).fields;
          addScope(fields, `excel:${sheet.name}!${cell.reference}`);
          for (const field of fields) {
            const known = stats.fields.find((item) => item.path === field.path);
            if (!known) stats.fields.push(field);
            else {
              known.count += field.count;
              for (const kind of field.kinds)
                if (!known.kinds.includes(kind)) known.kinds.push(kind);
              for (const scope of field.scopes)
                if (!known.scopes.includes(scope)) known.scopes.push(scope);
            }
          }
        }
  }
  return stats;
}

/** Rows between `{{#each}}` and `{{/each}}` are copied per item; same-row markers repeat that row. */
function rowEdits(
  parsed: ReturnType<typeof parsePart>,
  shared: readonly string[],
  data: TemplateValue,
  stats: ExcelTemplateStats,
  budget: TemplateBudget,
) {
  const rows = find(parsed.root, "row");
  const list = rows.map((row) => ({ row, cells: cells(parsed, row, shared) }));
  // Markers may share a cell with content (“{{#each rows}}{{name}}”), so a row is a loop row as
  // soon as any cell holds the tag; only the tags themselves are dropped when filling.
  const start = list.findIndex(({ cells: rowCells }) =>
    rowCells.some((cell) => /\{\{\s*#each\b/u.test(cell.text)),
  );
  if (start < 0) return { edits: [] };
  const close = list.findIndex(
    (entry, at) =>
      at >= start && entry.cells.some((cell) => /\{\{\s*\/each\s*\}\}/u.test(cell.text)),
  );
  const open = /\{\{\s*#each\s+([^{}]+?)\s*\}\}/u.exec(
    (list[start] as (typeof list)[number]).cells.map((cell) => cell.text).join(""),
  )?.[1];
  const path = open ? eachPath(`#each ${open}`) : undefined;
  if (!path || close < 0) {
    stats.warnings.push("excel_loop_unclosed");
    return { edits: [] };
  }
  const items = resolveItems(path, data);
  if (!items.length) stats.warnings.push("excel_loop_empty");
  const first = list[start] as (typeof list)[number];
  const last = list[close] as (typeof list)[number];
  const inner = list.slice(start + (start === close ? 0 : 1), start === close ? close + 1 : close);
  const templateCount = inner.length;
  const delta = (items.length || 1) * templateCount - (close - start + 1);
  const baseRow = Number(first.row.attrs.get("r") ?? start + 1);
  const edits: Edit[] = [];
  const generated: string[] = [];
  const copies = items.length ? items : [undefined];
  budget.repeat(
    copies.length,
    inner.map(({ row }) => row),
  );
  rowLoop: for (const [index, item] of copies.entries()) {
    const scopes: TemplateScope[] =
      item === undefined
        ? [{ value: data }]
        : [{ value: data }, { value: item, index, count: copies.length }];
    for (const [offset, entry] of inner.entries()) {
      const number = baseRow + index * templateCount + offset;
      const shift = number - Number(entry.row.attrs.get("r") ?? baseRow + offset);
      let clone = parsed.source.slice(entry.row.start, entry.row.end);
      const cellEdits: Edit[] = [];
      const bodyStart = entry.row.start;
      for (const cell of entry.cells) {
        const local = parsed.source.slice(cell.node.start, cell.node.end);
        const span = { start: cell.node.start - bodyStart, end: cell.node.end - bodyStart };
        if (!cell.text.includes("{{")) continue;
        // Loop markers only delimit the row; whatever else the cell holds still renders per item.
        const text = cell.text.replace(/\{\{\s*(?:#each[^{}]*|\/each)\s*\}\}/gu, "");
        const value = text.includes("{{")
          ? renderTemplate(parseTemplate(text, budget).nodes, data, budget, scopes)
          : "";
        const built = cellXml(
          local,
          {
            ...cell.node,
            start: 0,
            end: local.length,
            openEnd: cell.node.openEnd - cell.node.start,
            closeStart: cell.node.closeStart - cell.node.start,
          },
          value,
        );
        cellEdits.push({ ...span, value: built.value });
      }
      if (cellEdits.length) clone = applyEdits(clone, cellEdits);
      generated.push(renumberXml(clone, number, shift));
      if (index === 0 && item === undefined && templateCount === 0) break rowLoop;
    }
  }
  edits.push({ start: first.row.start, end: last.row.end, value: generated.join("") });
  stats.loops++;
  stats.rows += generated.length;

  // Everything below the block moves down by the rows the loop added or removed.
  for (const later of rows.slice(close + 1)) {
    const reference = Number(later.attrs.get("r") ?? 0);
    if (!reference) continue;
    const moved = renumber(parsed.source, later, reference + delta);
    edits.push({ start: later.start, end: later.end, value: moved });
  }
  const shift: RowShift = {
    from: baseRow,
    count: Number(last.row.attrs.get("r") ?? baseRow + (close - start)) - baseRow + 1,
    produced: generated.length,
  };
  return { edits, shift };
}

export function excelFill(
  pkg: OfficePackage,
  data: TemplateValue,
  budget: TemplateBudget,
): ExcelTemplateStats {
  const stats = excelFields(pkg, budget);
  const shared = sharedStrings(pkg);
  for (const sheet of sheetParts(pkg)) {
    const parsed = pkg.xml(sheet.part);
    const { edits: loopEdits, shift } = rowEdits(parsed, shared, data, stats, budget);
    const looped = loopEdits.length ? applyEdits(parsed.source, loopEdits) : parsed.source;
    const reparsed = parsePart(new TextEncoder().encode(looped));
    const edits: Edit[] = [];
    for (const row of find(reparsed.root, "row"))
      for (const cell of cells(reparsed, row, shared)) {
        if (!cell.text.includes("{{") || blockTag(cell.text)) continue;
        const value = renderTemplate(parseTemplate(cell.text, budget).nodes, data, budget, [
          { value: data },
        ]);
        edits.push(cellXml(reparsed.source, cell.node, value));
        stats.replacements++;
      }
    const filled = edits.length ? applyEdits(reparsed.source, edits) : reparsed.source;
    if (filled !== parsed.source) pkg.replacePart(sheet.part, new TextEncoder().encode(filled));
    // Ranges that address rows (merges, formats, validation, tables, names, charts) move with the
    // inserted rows; skipping this leaves them pointing at the data that used to be there.
    if (shift) applyRowShift(pkg, sheet, shift);
  }
  return stats;
}
