import type { ExcelOperation } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import type { Element, XmlPart } from "../xml.ts";
import { columns } from "./column-dimensions.ts";
import { type Area, address, area, columnName, sheetPart } from "./model.ts";
import { rowDimensions } from "./row-dimensions.ts";
import { Styles } from "./styles.ts";
import { children, nextOffset, patches, replace, ss, unique, withAttrs } from "./xml-edit.ts";

type Format = Extract<ExcelOperation, { op: "excel_format" }>;
export function formatCells(pkg: OfficePackage, op: Format) {
  const a = area(op.range),
    { part, xml } = sheetPart(pkg, op.sheet),
    styles = new Styles(pkg),
    cache = new Map<number, number>();
  const data = unique(xml.root, "sheetData");
  if (!data) throw new Error("office_invalid");
  const rows = new Map<number, ReturnType<typeof children>[number]>();
  for (const row of children(data, "row")) {
    const n = Number(row.attrs.get("r"));
    if (!Number.isInteger(n) || n < 1 || n > 1048576 || rows.has(n))
      throw new Error("office_invalid");
    rows.set(n, row);
  }
  const columnStyles = inheritedColumnStyles(xml, a);
  const edits: { start: number; end: number; value: string }[] = [],
    newRows: { index: number; value: string }[] = [];
  for (let r = a.firstRow; r <= a.lastRow; r++) {
    const changed = formatRow(xml, rows.get(r), r, a, styles, cache, columnStyles, op.style);
    edits.push(...changed.edits);
    newRows.push(...changed.newRows);
  }

  if (data.closeStart === data.end) {
    pkg.replaceXml(
      part,
      replace(xml, data, withAttrs(xml, data, {}, newRows.map((r) => r.value).join(""))),
    );
  } else {
    const sorted = Array.from(rows).sort(([a], [b]) => a - b),
      inserts = new Map<number, string[]>();
    for (const item of newRows) {
      const offset = nextOffset(sorted, item.index, data.closeStart);
      const list = inserts.get(offset) ?? [];
      list.push(item.value);
      inserts.set(offset, list);
    }
    for (const [offset, values] of inserts)
      edits.push({ start: offset, end: offset, value: values.join("") });
    pkg.replaceXml(part, patches(xml, edits));
  }
  extendDimension(pkg, part, a);
}

type Edit = { start: number; end: number; value: string };
type NewItem = { index: number; value: string };

function inheritedColumnStyles(xml: XmlPart, a: Area) {
  const cols = unique(xml.root, "cols"),
    columnStyles = new Map<number, number>();
  if (cols)
    for (const col of children(cols, "col")) {
      const first = Number(col.attrs.get("min")),
        last = Number(col.attrs.get("max"));
      if (
        !Number.isInteger(first) ||
        !Number.isInteger(last) ||
        first < 1 ||
        last > 16384 ||
        first > last
      )
        throw new Error("office_invalid");
      for (let c = Math.max(first, a.firstColumn); c <= Math.min(last, a.lastColumn); c++)
        columnStyles.set(c, Number(col.attrs.get("style") ?? 0));
    }
  return columnStyles;
}

function formatRow(
  xml: XmlPart,
  row: Element | undefined,
  r: number,
  a: Area,
  styles: Styles,
  cache: Map<number, number>,
  columnStyles: Map<number, number>,
  requestedStyle: Format["style"],
) {
  const edits: Edit[] = [],
    newRows: NewItem[] = [];
  const cells = new Map<number, Element>();
  if (row)
    for (const cell of children(row, "c")) {
      const pos = address(cell.attrs.get("r") ?? "");
      if (pos.row !== r || cells.has(pos.column)) throw new Error("office_invalid");
      cells.set(pos.column, cell);
    }
  const { cellEdits, newCells } = formattedCells(
    xml,
    row,
    r,
    a,
    styles,
    cache,
    columnStyles,
    requestedStyle,
    cells,
  );
  if (row) {
    const sorted = Array.from(cells).sort(([a], [b]) => a - b);
    const inserts = new Map<number, string[]>();
    for (const item of newCells) {
      const offset = nextOffset(sorted, item.index, unique(row, "extLst")?.start ?? row.closeStart);
      const list = inserts.get(offset) ?? [];
      list.push(item.value);
      inserts.set(offset, list);
    }
    for (const [offset, values] of inserts)
      cellEdits.push({ start: offset, end: offset, value: values.join("") });
    if (row.closeStart === row.end) {
      edits.push({
        start: row.start,
        end: row.end,
        value: withAttrs(xml, row, {}, newCells.map((c) => c.value).join("")),
      });
    } else edits.push(...cellEdits);
  } else
    newRows.push({
      index: r,
      value: ss("row", newCells.map((c) => c.value).join(""), { r }, xml.root.uri),
    });
  return { edits, newRows };
}

function extendDimension(pkg: OfficePackage, part: string, a: Area) {
  const changed = pkg.xml(part),
    dimension = unique(changed.root, "dimension");
  if (dimension) {
    const old = area(dimension.attrs.get("ref") ?? "A1", Number.MAX_SAFE_INTEGER);
    pkg.replaceXml(
      part,
      replace(
        changed,
        dimension,
        withAttrs(changed, dimension, {
          ref: `${columnName(Math.min(old.firstColumn, a.firstColumn))}${Math.min(old.firstRow, a.firstRow)}:${columnName(Math.max(old.lastColumn, a.lastColumn))}${Math.max(old.lastRow, a.lastRow)}`,
        }),
      ),
    );
  }
}

export function dimensions(
  pkg: OfficePackage,
  op: Extract<ExcelOperation, { op: "excel_dimensions" }>,
) {
  const { part } = sheetPart(pkg, op.sheet);
  if (op.columns?.length) columns(pkg, part, op.columns);
  if (op.rows?.length) rowDimensions(pkg, part, op.rows);
}

function formattedCells(
  xml: XmlPart,
  row: Element | undefined,
  r: number,
  a: Area,
  styles: Styles,
  cache: Map<number, number>,
  columnStyles: Map<number, number>,
  requestedStyle: Format["style"],
  cells: Map<number, Element>,
) {
  const cellEdits: { start: number; end: number; value: string }[] = [],
    newCells: { index: number; value: string }[] = [];
  for (let c = a.firstColumn; c <= a.lastColumn; c++) {
    const cell = cells.get(c),
      base = Number(cell?.attrs.get("s") ?? row?.attrs.get("s") ?? columnStyles.get(c) ?? 0);
    if (!Number.isInteger(base) || base < 0) throw new Error("office_invalid");
    let style = cache.get(base);
    if (style === undefined) {
      style = styles.style(base, requestedStyle);
      cache.set(base, style);
    }
    const value = cell
      ? withAttrs(xml, cell, { s: style })
      : ss("c", "", { r: `${columnName(c)}${r}`, s: style }, xml.root.uri);
    if (cell) cellEdits.push({ start: cell.start, end: cell.end, value });
    else newCells.push({ index: c, value });
  }
  return { cellEdits, newCells };
}
