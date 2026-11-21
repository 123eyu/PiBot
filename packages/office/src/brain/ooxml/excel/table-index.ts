import { DOC_REL, type OfficePackage, STRICT_REL } from "../package.ts";
import { attribute } from "../xml.ts";
import { area, book, overlaps, relation } from "./model.ts";
import { children, unique } from "./xml-edit.ts";

export function workbookTables(pkg: OfficePackage) {
  const b = book(pkg),
    sheets = unique(b.xml.root, "sheets");
  const result: {
    sheetPart: string;
    part: string;
    root: ReturnType<OfficePackage["xml"]>["root"];
  }[] = [];
  const seen = new Set<string>();
  for (const sheet of sheets ? children(sheets, "sheet") : []) {
    const id = attribute(sheet, "id", DOC_REL) ?? attribute(sheet, "id", STRICT_REL);
    if (!id) throw new Error("office_invalid");
    const source = relation(pkg, b.part, "worksheet", id);
    for (const rel of pkg.relationships(source)) {
      if (![DOC_REL, STRICT_REL].some((ns) => rel.type === `${ns}/table`)) continue;
      if (!rel.target || seen.has(rel.target)) throw new Error("office_target_ambiguous");
      seen.add(rel.target);
      const root = pkg.xml(rel.target).root;
      if (root.name !== "table" || root.uri !== b.xml.root.uri) throw new Error("office_invalid");
      result.push({ sheetPart: source, part: rel.target, root });
    }
  }
  return result;
}
export function assertNoTableOverlap(pkg: OfficePackage, part: string, range: string) {
  const target = area(range, Number.MAX_SAFE_INTEGER);
  if (
    workbookTables(pkg).some(
      (t) =>
        t.sheetPart === part &&
        overlaps(target, area(t.root.attrs.get("ref") ?? "", Number.MAX_SAFE_INTEGER)),
    )
  )
    throw new Error("office_excel_range_overlap");
}
