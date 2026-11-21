import type { ExcelOperation } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import { children, nextOffset, patches, replace, ss, unique, withAttrs } from "./xml-edit.ts";

type Dimensions = Extract<ExcelOperation, { op: "excel_dimensions" }>;
export function rowDimensions(
  pkg: OfficePackage,
  part: string,
  updates: NonNullable<Dimensions["rows"]>,
) {
  const xml = pkg.xml(part),
    data = unique(xml.root, "sheetData");
  if (!data) throw new Error("office_invalid");
  const heights = new Map<number, number>();
  for (const dim of updates) {
    if (dim.first > dim.last || dim.last - dim.first > 9999) throw new Error("office_invalid");
    for (let r = dim.first; r <= dim.last; r++) {
      heights.set(r, dim.height);
      if (heights.size > 10000) throw new Error("office_invalid");
    }
  }
  const existing = new Map<number, typeof xml.root>();
  for (const row of children(data, "row")) {
    const r = Number(row.attrs.get("r"));
    if (!Number.isInteger(r) || existing.has(r)) throw new Error("office_invalid");
    existing.set(r, row);
  }
  const edits: { start: number; end: number; value: string }[] = [],
    insertions = new Map<number, string[]>();
  const sorted = Array.from(existing).sort(([a], [b]) => a - b);
  for (const [r, height] of Array.from(heights).sort(([a], [b]) => a - b)) {
    const row = existing.get(r),
      value = row
        ? withAttrs(xml, row, { ht: height, customHeight: 1 })
        : ss("row", "", { r, ht: height, customHeight: 1 }, xml.root.uri);
    if (row) edits.push({ start: row.start, end: row.end, value });
    else {
      const offset = nextOffset(sorted, r, data.closeStart);
      const list = insertions.get(offset) ?? [];
      list.push(value);
      insertions.set(offset, list);
    }
  }
  if (data.closeStart === data.end)
    pkg.replaceXml(
      part,
      replace(xml, data, withAttrs(xml, data, {}, Array.from(insertions.values()).flat().join(""))),
    );
  else {
    for (const [offset, list] of insertions)
      edits.push({ start: offset, end: offset, value: list.join("") });
    pkg.replaceXml(part, patches(xml, edits));
  }
}
