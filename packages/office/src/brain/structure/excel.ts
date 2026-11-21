import type { OfficeStructureItem } from "@pibot/protocol-base/office-content";
import { elements, leafText, type XmlPart } from "../ooxml/xml.ts";
import { formulaReferences } from "./formula.ts";
import type { StructureContext } from "./page.ts";
import { attr, belongs, byKind, child, natural, nodes, relations, SHEET, target } from "./xml.ts";

export function* excelStructure(ctx: StructureContext): Generator<OfficeStructureItem> {
  const { pkg, budget, summary, query } = ctx;
  const main = pkg.mainPart();
  const workbook = pkg.xml(main);
  if (workbook.root.name !== "workbook" || !belongs(workbook.root, SHEET))
    throw new Error("office_invalid_document");
  const workbookRels = relations(pkg, main);
  const sheets =
    child(workbook.root, "sheets", SHEET)?.children.filter(
      (sheet) => sheet.name === "sheet" && belongs(sheet, SHEET),
    ) ?? [];
  summary.sheets = sheets.length;
  if (!query.collection || query.collection === "defined_name") yield* definedNames(ctx, workbook);
  if (query.collection === "defined_name") return;
  for (const [index, sheet] of sheets.entries()) {
    if (query.sheet !== undefined && query.sheet !== index) continue;
    yield { kind: "sheet", sheet: index, name: budget.clip(attr(sheet, "name")) ?? "" };
    if (query.collection === "sheet") continue;
    const part =
      target(workbookRels, sheet, "worksheet") ?? target(workbookRels, sheet, "chartsheet");
    const xml = pkg.optional(part, main);
    if (xml && part) yield* worksheet(ctx, xml, part, index);
  }
}
function* definedNames(ctx: StructureContext, workbook: XmlPart): Generator<OfficeStructureItem> {
  const definitions = child(workbook.root, "definedNames", SHEET);
  for (const node of definitions?.children ?? []) {
    if (node.name !== "definedName" || !belongs(node, SHEET)) continue;
    yield {
      kind: "defined_name",
      name: ctx.budget.clip(attr(node, "name")) ?? "",
      reference: ctx.budget.clip(leafText(workbook, node)) ?? "",
      localSheet: natural(attr(node, "localSheetId")),
    };
  }
}
function wants(ctx: StructureContext, kind: OfficeStructureItem["kind"]) {
  return !ctx.query.collection || ctx.query.collection === kind;
}
function* worksheet(
  ctx: StructureContext,
  xml: XmlPart,
  part: string,
  sheet: number,
): Generator<OfficeStructureItem> {
  if (wants(ctx, "formula")) yield* formulas(ctx, xml, part, sheet);
  if (wants(ctx, "validation")) yield* validations(ctx, xml, sheet);
  if (wants(ctx, "excel_table")) yield* tables(ctx, xml, part, sheet);
  if (wants(ctx, "pivot_table")) yield* pivots(ctx, part, sheet);
  if (wants(ctx, "chart")) yield* charts(ctx, xml, part, sheet);
}
function* formulas(
  ctx: StructureContext,
  xml: XmlPart,
  part: string,
  sheet: number,
): Generator<OfficeStructureItem> {
  for (const cell of nodes(xml.root, "c", SHEET)) {
    const formula = child(cell, "f", SHEET);
    if (!formula) continue;
    ctx.summary.formulas = true;
    const address = attr(cell, "r");
    if (!address) {
      yield { kind: "problem", part, sheet, code: "missing_cell_address" };
      continue;
    }
    const source = leafText(xml, formula);
    const type = attr(formula, "t");
    const refs = formulaReferences(source, type ?? "normal");
    yield {
      kind: "formula",
      sheet,
      address: ctx.budget.clip(address) ?? "",
      formula: ctx.budget.clip(source),
      formulaType: ctx.budget.clip(type),
      sharedIndex: ctx.budget.clip(attr(formula, "si")),
      range: ctx.budget.clip(attr(formula, "ref")),
      ...refs,
    };
  }
}
function* validations(
  ctx: StructureContext,
  xml: XmlPart,
  sheet: number,
): Generator<OfficeStructureItem> {
  for (const node of nodes(xml.root, "dataValidation", SHEET)) {
    const f1 = child(node, "formula1", SHEET),
      f2 = child(node, "formula2", SHEET);
    yield {
      kind: "validation",
      sheet,
      range: ctx.budget.clip(attr(node, "sqref")) ?? "",
      type: ctx.budget.clip(attr(node, "type")),
      formula1: ctx.budget.clip(f1 && leafText(xml, f1)),
      formula2: ctx.budget.clip(f2 && leafText(xml, f2)),
    };
  }
}
function* tables(
  ctx: StructureContext,
  xml: XmlPart,
  part: string,
  sheet: number,
): Generator<OfficeStructureItem> {
  const rels = relations(ctx.pkg, part);
  for (const node of nodes(xml.root, "tablePart", SHEET)) {
    const tablePart = target(rels, node, "table");
    const table = ctx.pkg.optional(tablePart, part)?.root;
    if (!table || !tablePart) continue;
    yield {
      kind: "excel_table",
      sheet,
      part: tablePart,
      name: ctx.budget.clip(attr(table, "name")) ?? "",
      range: ctx.budget.clip(attr(table, "ref")),
    };
  }
}
function* pivots(
  ctx: StructureContext,
  part: string,
  sheet: number,
): Generator<OfficeStructureItem> {
  for (const pivotPart of byKind(relations(ctx.pkg, part), "pivotTable")) {
    const pivot = ctx.pkg.optional(pivotPart, part)?.root;
    if (!pivot) continue;
    yield {
      kind: "pivot_table",
      sheet,
      part: pivotPart,
      name: ctx.budget.clip(attr(pivot, "name")) ?? "",
      cacheId: ctx.budget.clip(attr(pivot, "cacheId")),
      range: ctx.budget.clip(attr(child(pivot, "location", SHEET), "ref")),
    };
  }
}
function* charts(
  ctx: StructureContext,
  xml: XmlPart,
  part: string,
  sheet: number,
): Generator<OfficeStructureItem> {
  const rels = relations(ctx.pkg, part);
  for (const node of nodes(xml.root, "drawing", SHEET)) {
    const drawing = target(rels, node, "drawing");
    const drawingXml = ctx.pkg.optional(drawing, part);
    if (!drawing || !drawingXml) continue;
    const drawingRels = relations(ctx.pkg, drawing);
    for (const chart of elements(drawingXml.root)) {
      if (chart.name !== "chart" || !/\/drawingml\/(?:2006\/)?chart$/u.test(chart.uri)) continue;
      const chartPart = target(drawingRels, chart, "chart");
      const chartXml = ctx.pkg.optional(chartPart, drawing);
      if (chartPart && chartXml) yield chartItem(sheet, chartPart, chartXml);
    }
  }
}
function chartItem(sheet: number, part: string, xml: XmlPart): OfficeStructureItem {
  const types = new Set<string>();
  for (const node of elements(xml.root))
    if (node.name.endsWith("Chart") && /drawingml\/.*chart|drawingml\/chart/u.test(node.uri))
      types.add(node.name);
  return { kind: "chart", sheet, part, types: [...types].slice(0, 16) };
}
