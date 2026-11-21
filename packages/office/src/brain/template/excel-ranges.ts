import { OfficeError } from "../errors.ts";
import type { OfficePackage } from "../ooxml/package.ts";
import { applyEdits } from "./xml-text.ts";

/**
 * A loop block was replaced by `produced` rows where the template had `count` rows starting at `from`
 * (1-based). Rows below the insertion point move by `produced - count`; ranges that start above and end
 * below it must grow or shrink with it, or Excel shows ranges pointing at the wrong data.
 */
export interface RowShift {
  readonly from: number;
  readonly count: number;
  readonly produced: number;
}

const ROW = /(\$?[A-Z]{1,3})(\$?)(\d+)/gu;
const QUALIFIED =
  /((?:'(?:[^']|'')+'|[^!,'"()=;{}\s]+))!((?:\$?[A-Z]{1,3}\$?\d+)(?::(?:\$?[A-Z]{1,3}\$?\d+))?)/gu;

function mapRow(row: number, shift: RowShift, edge: "start" | "end") {
  if (row < shift.from) return row;
  const delta = shift.produced - shift.count;
  if (row >= shift.from + shift.count) return row + delta;
  // A range edge inside the repeated block: its start stays at the block, its end follows the block
  // to the last produced row, so "B2:B5" becomes "B2:B8" instead of pointing at the data below.
  return edge === "start" ? shift.from : shift.from + Math.max(shift.produced, 1) - 1;
}

function shiftEndpoint(endpoint: string, shift: RowShift, edge: "start" | "end") {
  return endpoint.replace(
    ROW,
    (_match, letters: string, absolute: string, row: string) =>
      `${letters}${absolute}${mapRow(Number(row), shift, edge)}`,
  );
}

/**
 * Shifts only the row part of an A1 reference; absolute rows ($5) move too, whole columns stay.
 * Both ends are mapped separately so a region spanning the insertion point grows with it.
 */
function shiftRef(reference: string, shift: RowShift) {
  const [first = "", second] = reference.split(":");
  const head = shiftEndpoint(first, shift, "start");
  return second === undefined ? head : `${head}:${shiftEndpoint(second, shift, "end")}`;
}

function shiftList(value: string, shift: RowShift) {
  return value
    .split(/\s+/u)
    .filter(Boolean)
    .map((reference) => shiftRef(reference, shift))
    .join(" ");
}

function escapeName(name: string) {
  return name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertResolved(text: string, name: string) {
  const marker = new RegExp(`(?:'${escapeName(name)}'|${escapeName(name)})!`, "gu");
  for (const match of text.matchAll(marker)) {
    const rest = text.slice((match.index ?? 0) + match[0].length);
    if (!/^\$?[A-Z]{1,3}(?:\$?\d+|:\$?[A-Z]{1,3})/u.test(rest))
      throw new OfficeError("office_template_unsupported");
  }
}

/** Rewrites `Sheet!$A$1:$B$5` (and quoted sheet names) that point at the shifted sheet. */
export function shiftFormula(text: string, name: string, shift: RowShift) {
  const target = name.toLowerCase();
  const out = text.replace(QUALIFIED, (match, sheet: string, reference: string) => {
    const bare = sheet.startsWith("'") ? sheet.slice(1, -1).replaceAll("''", "'") : sheet;
    return bare.toLowerCase() === target ? `${sheet}!${shiftRef(reference, shift)}` : match;
  });
  // A mention we cannot parse (3-D or external reference) would silently keep the old rows.
  assertResolved(out, name);
  return out;
}

const CELL =
  /(?:('(?:[^']|'')+'|[^!,'"()=;{}[\]\s]+)!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?/gu;

/**
 * Rewrites the cell references of one formula with the same expand/shift rule as sheet ranges, so a
 * `SUM(B2:B5)` inside a moved row keeps counting the rows the loop just inserted. Quoted text and the
 * `$` markers are preserved; a reference to another sheet is shifted only when it is ours.
 */
function shiftFormulaBody(body: string, name: string, shift: RowShift, onlyQualified: boolean) {
  const target = name.toLowerCase();
  return body
    .split('"')
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(CELL, (match, sheet: string | undefined, head: string, tail?: string) => {
            if (sheet === undefined)
              return onlyQualified ? match : shiftRef(tail ? `${head}:${tail}` : head, shift);
            const bare = sheet.startsWith("'") ? sheet.slice(1, -1).replaceAll("''", "'") : sheet;
            if (bare.toLowerCase() !== target) return match;
            return `${sheet}!${shiftRef(tail ? `${head}:${tail}` : head, shift)}`;
          }),
    )
    .join('"');
}

const FORMULA = /(<f\b[^>]*>)([^<]*)(<\/f>)/gu;
const ROW_TAG = /<row\b[^>]*?\sr="(\d+)"[^>]*>[\s\S]*?<\/row>/gu;

/**
 * Formula edits for one worksheet part. `skipGenerated` leaves the rows the loop itself produced
 * alone: their references were already copied relative to each item, and shifting them again would
 * break the per-row formulas (`=B2*C2` replicated as `=B3*C3`, ...).
 */
function formulaEdits(source: string, name: string, shift: RowShift, skipGenerated: boolean) {
  const edits: Edit[] = [];
  const generatedEnd = shift.from + Math.max(shift.produced, 1);
  for (const row of source.matchAll(ROW_TAG)) {
    const number = Number(row[1]);
    if (skipGenerated && number >= shift.from && number < generatedEnd) continue;
    const rowStart = row.index ?? 0;
    for (const formula of row[0].matchAll(FORMULA)) {
      const open = formula[1] ?? "";
      const body = formula[2] ?? "";
      const shifted = shiftFormulaBody(body, name, shift, !skipGenerated);
      if (shifted === body) continue;
      const start = rowStart + (formula.index ?? 0) + open.length;
      edits.push({ start, end: start + body.length, value: shifted });
    }
  }
  return edits;
}

type Edit = { start: number; end: number; value: string };

function attrEdits(source: string, tag: string, attribute: string, shift: RowShift) {
  const pattern = new RegExp(`(<(?:[\\w.-]+:)?${tag}\\b[^>]*?\\s${attribute}=")([^"]*)(")`, "gu");
  const edits: Edit[] = [];
  for (const match of source.matchAll(pattern)) {
    const shifted = shiftList(match[2] as string, shift);
    if (shifted === match[2]) continue;
    edits.push({
      start: match.index,
      end: match.index + match[0].length,
      value: `${match[1]}${shifted}${match[3]}`,
    });
  }
  return edits;
}

function textEdits(source: string, tag: string, shift: RowShift, name?: string) {
  const pattern = new RegExp(`(<${tag}\\b[^>]*>)([^<]*)(</${tag}>)`, "gu");
  const edits: Edit[] = [];
  for (const match of source.matchAll(pattern)) {
    const body = match[2] as string;
    const shifted = name ? shiftFormula(body, name, shift) : shiftList(body, shift);
    if (shifted === body) continue;
    edits.push({
      start: match.index,
      end: match.index + match[0].length,
      value: `${match[1]}${shifted}${match[3]}`,
    });
  }
  return edits;
}

function apply(pkg: OfficePackage, part: string, edits: Edit[]) {
  if (!edits.length) return false;
  pkg.replaceXml(part, applyEdits(pkg.xml(part).source, edits));
  return true;
}

/**
 * Worksheet ranges that address rows: dimensions, merged cells, conditional formats, data validation,
 * hyperlinks and the sheet autofilter. All of them share the same row arithmetic, so one pass covers
 * them; missing one leaves Excel pointing at the wrong rows.
 */
function shiftSheet(pkg: OfficePackage, part: string, name: string, shift: RowShift) {
  const source = pkg.xml(part).source;
  return apply(pkg, part, [
    ...attrEdits(source, "dimension", "ref", shift),
    ...attrEdits(source, "mergeCell", "ref", shift),
    ...attrEdits(source, "conditionalFormatting", "sqref", shift),
    ...textEdits(source, "xm:sqref", shift),
    ...attrEdits(source, "dataValidation", "sqref", shift),
    ...attrEdits(source, "hyperlink", "ref", shift),
    ...attrEdits(source, "autoFilter", "ref", shift),
    ...formulaEdits(source, name, shift, true),
  ]);
}

/**
 * Other sheets keep their own rows, but formulas there that name this sheet address the rows that
 * just moved; leaving them alone would make a cross-sheet total miss the inserted rows.
 */
function shiftOtherSheets(pkg: OfficePackage, ownPart: string, name: string, shift: RowShift) {
  let changed = false;
  for (const part of pkg.names())
    if (/^xl\/worksheets\/[^/]+\.xml$/u.test(part) && part !== ownPart)
      changed = apply(pkg, part, formulaEdits(pkg.xml(part).source, name, shift, false)) || changed;
  return changed;
}

/** Tables live in their own parts, reached through the worksheet's `tableParts` relationships. */
function shiftTables(pkg: OfficePackage, sheetPart: string, shift: RowShift) {
  let changed = false;
  // `relationships` already resolves targets to part names, so the table parts are found directly.
  for (const rel of pkg.relationships(sheetPart)) {
    const target = rel.target;
    if (!target || !/(?:^|\/)tables\/[^/]+\.xml$/u.test(target)) continue;
    const source = pkg.xml(target).source;
    changed =
      apply(pkg, target, [
        ...attrEdits(source, "table", "ref", shift),
        ...attrEdits(source, "autoFilter", "ref", shift),
      ]) || changed;
  }
  return changed;
}

/** Workbook names may point at the shifted range (`Print_Area`, data ranges); shift the same rows. */
function shiftNames(pkg: OfficePackage, name: string, shift: RowShift) {
  const part = pkg.mainPart();
  const source = pkg.xml(part).source;
  const pattern = /(<definedName\b[^>]*>)([\s\S]*?)(<\/definedName>)/gu;
  const edits: Edit[] = [];
  for (const match of source.matchAll(pattern)) {
    const body = match[2] as string;
    const shifted = shiftFormula(body, name, shift);
    if (shifted === body) continue;
    edits.push({
      start: match.index,
      end: match.index + match[0].length,
      value: `${match[1]}${shifted}${match[3]}`,
    });
  }
  return apply(pkg, part, edits);
}

/** Chart series address rows too; their caches are left stale because Excel recalculates on open. */
function shiftCharts(pkg: OfficePackage, name: string, shift: RowShift) {
  let changed = false;
  for (const part of pkg.names())
    if (/^xl\/charts\/[^/]+\.xml$/u.test(part)) {
      const source = pkg.xml(part).source;
      changed = apply(pkg, part, textEdits(source, "c:f", shift, name)) || changed;
    }
  return changed;
}

/**
 * Moves every row-addressed range after a loop expanded. Throws `office_template_unsupported` when a
 * reference cannot be rewritten, so a shifted-but-wrong file is never published.
 */
export function applyRowShift(
  pkg: OfficePackage,
  sheet: { part: string; name: string },
  shift: RowShift,
) {
  if (shift.produced === shift.count) return false;
  shiftSheet(pkg, sheet.part, sheet.name, shift);
  shiftOtherSheets(pkg, sheet.part, sheet.name, shift);
  shiftTables(pkg, sheet.part, shift);
  shiftNames(pkg, sheet.name, shift);
  shiftCharts(pkg, sheet.name, shift);
  return true;
}
