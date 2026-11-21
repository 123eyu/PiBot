import { posix } from "node:path";
import { one } from "../locate.ts";
import { DOC_REL, type OfficePackage, STRICT_REL } from "../package.ts";
import { attribute, type Element, leafText, type XmlPart } from "../xml.ts";
import { children, SS, unique } from "./xml-edit.ts";

export interface Area {
  firstColumn: number;
  lastColumn: number;
  firstRow: number;
  lastRow: number;
  ref: string;
}
export function columnName(column: number) {
  let value = "";
  while (column) {
    column--;
    value = String.fromCharCode(65 + (column % 26)) + value;
    column = Math.floor(column / 26);
  }
  return value;
}
export function address(value: string) {
  const match = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})$/u.exec(value);
  if (!match) throw new Error("office_invalid");
  let column = 0;
  for (const char of match[1] ?? "") column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16384 || row > 1048576) throw new Error("office_invalid");
  return { column, row };
}
export function area(ref: string, maxCells = 10000): Area {
  const parts = ref.split(":"),
    first = address(parts[0] ?? ""),
    last = address(parts[1] ?? parts[0] ?? "");
  if (
    parts.length > 2 ||
    first.column > last.column ||
    first.row > last.row ||
    (last.column - first.column + 1) * (last.row - first.row + 1) > maxCells
  )
    throw new Error("office_invalid");
  return {
    firstColumn: first.column,
    lastColumn: last.column,
    firstRow: first.row,
    lastRow: last.row,
    ref: `${columnName(first.column)}${first.row}${first.row === last.row && first.column === last.column ? "" : `:${columnName(last.column)}${last.row}`}`,
  };
}
export function overlaps(a: Area, b: Area) {
  return (
    a.firstColumn <= b.lastColumn &&
    a.lastColumn >= b.firstColumn &&
    a.firstRow <= b.lastRow &&
    a.lastRow >= b.firstRow
  );
}
export function book(pkg: OfficePackage) {
  const part = pkg.mainPart(),
    xml = pkg.xml(part);
  if (
    xml.root.name !== "workbook" ||
    ![SS, "http://purl.oclc.org/ooxml/spreadsheetml/main"].includes(xml.root.uri)
  )
    throw new Error("office_unsupported");
  return { part, xml };
}
export function relation(pkg: OfficePackage, part: string, suffix: string, id?: string) {
  const rel = one(
    pkg
      .relationships(part)
      .filter(
        (r) =>
          (id === undefined || r.id === id) &&
          [DOC_REL, STRICT_REL].some((ns) => r.type === `${ns}/${suffix}`),
      ),
  );
  if (!rel.target) throw new Error("office_target_ambiguous");
  return rel.target;
}
export function sheetPart(pkg: OfficePackage, name: string) {
  const b = book(pkg),
    sheets = unique(b.xml.root, "sheets");
  if (!sheets) throw new Error("office_target_ambiguous");
  const node = one(children(sheets, "sheet").filter((n) => n.attrs.get("name") === name));
  const id = attribute(node, "id", DOC_REL) ?? attribute(node, "id", STRICT_REL);
  if (!id) throw new Error("office_target_ambiguous");
  const part = relation(pkg, b.part, "worksheet", id),
    xml = pkg.xml(part);
  if (xml.root.name !== "worksheet" || xml.root.uri !== b.xml.root.uri)
    throw new Error("office_unsupported");
  return { part, xml };
}
export function nextPart(pkg: OfficePackage, prefix: string) {
  for (let i = 1; i <= 2000; i++) {
    const part = `${prefix}${i}.xml`;
    if (!pkg.has(part)) return part;
  }
  throw new Error("office_invalid");
}
export function addRelated(pkg: OfficePackage, source: string, target: string, kind: string) {
  const ids = new Set(pkg.relationships(source).map((r) => r.id));
  let n = 1;
  while (ids.has(`rId${n}`)) n++;
  const id = `rId${n}`,
    ns = book(pkg).xml.root.uri === SS ? DOC_REL : STRICT_REL;
  pkg.addRelationship(source, id, `${ns}/${kind}`, posix.relative(posix.dirname(source), target));
  return { id, ns };
}
export function reference(ref: { sheet: string; range: string }) {
  const a = area(ref.range);
  return `'${ref.sheet.replaceAll("'", "''")}'!$${columnName(a.firstColumn)}$${a.firstRow}:$${columnName(a.lastColumn)}$${a.lastRow}`;
}
export function cellIndex(xml: XmlPart) {
  const data = unique(xml.root, "sheetData");
  if (!data) throw new Error("office_invalid");
  const cells = new Map<string, Element>();
  for (const row of children(data, "row"))
    for (const cell of children(row, "c")) {
      const ref = cell.attrs.get("r");
      if (!ref || cells.has(ref)) throw new Error("office_target_ambiguous");
      address(ref);
      cells.set(ref, cell);
    }
  return cells;
}
export function values(pkg: OfficePackage, ref: { sheet: string; range: string }) {
  const a = area(ref.range);
  if (a.firstRow !== a.lastRow && a.firstColumn !== a.lastColumn) throw new Error("office_invalid");
  const { xml } = sheetPart(pkg, ref.sheet),
    cells = cellIndex(xml),
    b = book(pkg);
  const shared = pkg
    .relationships(b.part)
    .filter(
      (r) => !r.external && [DOC_REL, STRICT_REL].some((ns) => r.type === `${ns}/sharedStrings`),
    );
  const strings = shared.length ? pkg.xml(relation(pkg, b.part, "sharedStrings")) : undefined;
  const items = strings ? children(strings.root, "si") : [];
  const result: (string | number | null)[] = [];
  function text(node: Element, source: XmlPart): string {
    if (node.name === "rPh" && node.uri === source.root.uri) return "";
    return node.name === "t"
      ? (leafText(source, node) ?? "")
      : node.children.map((n) => text(n, source)).join("");
  }
  for (let row = a.firstRow; row <= a.lastRow; row++)
    for (let col = a.firstColumn; col <= a.lastColumn; col++) {
      const cell = cells.get(`${columnName(col)}${row}`),
        v = cell && unique(cell, "v");
      const raw = v && leafText(xml, v);
      let value: string | number | null = null;
      const type = cell?.attrs.get("t");
      if (cell && type === "inlineStr") value = text(cell, xml);
      else if (raw !== undefined) {
        if (type === "s") {
          const item = items[Number(raw)];
          if (!/^\d+$/u.test(raw) || !item || !strings) throw new Error("office_invalid");
          value = text(item, strings);
        } else if (type === "e") value = null;
        else if (type === "str" || type === "d") value = raw;
        else {
          value = Number(raw);
          if (!Number.isFinite(value)) value = null;
        }
      }
      result.push(value);
    }
  return result;
}
