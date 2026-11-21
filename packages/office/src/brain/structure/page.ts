import type { OfficeFormat } from "@pibot/protocol-base/office-content";
import {
  type OfficeStructureItem,
  type OfficeStructurePage,
  OfficeStructurePageSchema,
  type OfficeStructureQuery,
} from "@pibot/protocol-base/office-content";
import { OfficePackage } from "../ooxml/package.ts";
import { boundItem } from "./budget.ts";
import { excelStructure } from "./excel.ts";
import { StructurePackage } from "./package.ts";
import { presentationStructure } from "./presentation.ts";
import { wordStructure } from "./word.ts";
import { TextBudget } from "./xml.ts";

export type Summary = OfficeStructurePage["summary"];
export type StructureContext = {
  pkg: StructurePackage;
  query: OfficeStructureQuery;
  budget: TextBudget;
  summary: Summary;
};

/** Only the requested page crosses the worker boundary, even for sparse workbooks. */
export async function inspectStructure(
  bytes: Uint8Array,
  format: OfficeFormat,
  query: OfficeStructureQuery = {},
): Promise<OfficeStructurePage> {
  const pkg = new StructurePackage(await OfficePackage.open(bytes));
  const summary: Summary = { macros: false, externalLinks: false };
  pkg.validate(summary);
  const budget = new TextBudget();
  const ctx = { pkg, budget, summary, query };
  const generator =
    format === "docx"
      ? wordStructure(ctx)
      : format === "xlsx"
        ? excelStructure(ctx)
        : presentationStructure(ctx);
  return collectPage(generator, ctx);
}
function collectPage(generator: Generator<OfficeStructureItem>, ctx: StructureContext) {
  const { query } = ctx;
  const items: OfficeStructureItem[] = [];
  const offset = query.offset ?? 0;
  const limit = Math.min(query.limit ?? 20, 20);
  let total = 0;
  let size = 0;
  let full = false;
  for (const item of withProblems(generator, ctx.pkg)) {
    const clipped = ctx.budget.truncated;
    ctx.budget.truncated = false;
    if (!matches(item, query)) continue;
    const index = total++;
    if (index < offset || full) continue;
    const bounded = boundItem(item, clipped);
    const bytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
    if (items.length >= limit || (items.length > 0 && size + bytes > 20 * 1024)) {
      full = true;
      continue;
    }
    items.push(bounded);
    size += bytes;
  }
  return OfficeStructurePageSchema.parse({
    summary: ctx.summary,
    items,
    total,
    offset,
    nextOffset: offset + items.length < total ? offset + items.length : null,
    truncated: items.some((item) => item.truncated),
    warnings: structureWarnings(ctx.summary),
    editSupport:
      "Word edits, Excel formatting and charts, PowerPoint slide and shape edits, and OOXML text replacement. See office_capabilities(format) for options and limits.",
    coverage: "bounded_structure; no layout, formula evaluation or external content loading",
  });
}

function* withProblems(items: Generator<OfficeStructureItem>, pkg: StructurePackage) {
  yield* items;
  yield* pkg.problems;
}
function structureWarnings(summary: Summary) {
  return [
    ...(summary.macros ? ["office_macros_not_executed"] : []),
    ...(summary.externalLinks ? ["office_external_links_not_loaded"] : []),
    ...(summary.fields ? ["office_fields_not_evaluated"] : []),
    ...(summary.formulas ? ["office_formula_cached_not_recalculated"] : []),
  ];
}

function matches(item: OfficeStructureItem, query: OfficeStructureQuery) {
  if (item.kind === "problem") return true;
  if (query.collection && item.kind !== query.collection) return false;
  if (query.sheet !== undefined && (!("sheet" in item) || item.sheet !== query.sheet)) return false;
  return query.slide === undefined || ("slide" in item && item.slide === query.slide);
}
