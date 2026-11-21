import type { ExcelOperation } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import { encoder } from "../xml.ts";
import {
  addRelated,
  area,
  book,
  columnName,
  nextPart,
  overlaps,
  sheetPart,
  values,
} from "./model.ts";
import { workbookTables } from "./table-index.ts";
import { children, replace, setChild, ss, tag, unique, withAttrs } from "./xml-edit.ts";

export function table(pkg: OfficePackage, op: Extract<ExcelOperation, { op: "excel_table" }>) {
  const a = area(op.range);
  if (
    a.lastRow <= a.firstRow ||
    a.lastColumn - a.firstColumn + 1 !== op.columns.length ||
    new Set(op.columns.map((c) => c.toLowerCase())).size !== op.columns.length ||
    /^(?:[A-Za-z]{1,3}[1-9][0-9]*|R[0-9]*C[0-9]*|R|C)$/iu.test(op.name)
  )
    throw new Error("office_invalid");
  const headers = values(pkg, {
    sheet: op.sheet,
    range: `${columnName(a.firstColumn)}${a.firstRow}:${columnName(a.lastColumn)}${a.firstRow}`,
  });
  if (headers.some((v, i) => v !== op.columns[i])) throw new Error("office_target_ambiguous");
  const { part, xml } = sheetPart(pkg, op.sheet);
  const b = book(pkg),
    defined = unique(b.xml.root, "definedNames");
  if (
    defined &&
    children(defined, "definedName").some(
      (n) => n.attrs.get("name")?.toLowerCase() === op.name.toLowerCase(),
    )
  )
    throw new Error("office_target_ambiguous");
  let id = 0;
  for (const { root } of workbookTables(pkg)) {
    const n = Number(root.attrs.get("id"));
    if (!Number.isInteger(n) || n < 1 || n >= 0xffff_ffff) throw new Error("office_invalid");
    id = Math.max(id, n);
    if (
      [root.attrs.get("name"), root.attrs.get("displayName")].some(
        (n) => n?.toLowerCase() === op.name.toLowerCase(),
      )
    )
      throw new Error("office_target_ambiguous");
  }
  const filter = unique(xml.root, "autoFilter"),
    merged = unique(xml.root, "mergeCells");
  const conflicts = [...(filter ? [filter] : []), ...(merged ? children(merged, "mergeCell") : [])];
  if (
    conflicts.some((n) => overlaps(a, area(n.attrs.get("ref") ?? "", Number.MAX_SAFE_INTEGER))) ||
    workbookTables(pkg).some(
      (t) =>
        t.sheetPart === part &&
        overlaps(a, area(t.root.attrs.get("ref") ?? "", Number.MAX_SAFE_INTEGER)),
    )
  )
    throw new Error("office_excel_range_overlap");
  const path = nextPart(pkg, "xl/tables/table");
  pkg.addPart(
    path,
    encoder.encode(
      ss(
        "table",
        tag("autoFilter", "", { ref: a.ref }) +
          tag(
            "tableColumns",
            op.columns.map((name, i) => tag("tableColumn", "", { id: i + 1, name })).join(""),
            { count: op.columns.length },
          ) +
          tag("tableStyleInfo", "", {
            name: op.style,
            showFirstColumn: false,
            showLastColumn: false,
            showRowStripes: true,
            showColumnStripes: false,
          }),
        { id: id + 1, name: op.name, displayName: op.name, ref: a.ref, totalsRowShown: false },
        xml.root.uri,
      ),
    ),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml",
  );
  const rel = addRelated(pkg, part, path, "table"),
    current = pkg.xml(part),
    parent = unique(current.root, "tableParts"),
    items = parent ? children(parent, "tablePart") : [];
  const value = ss("tablePart", "", { "xmlns:r": rel.ns, "r:id": rel.id }, xml.root.uri);
  pkg.replaceXml(
    part,
    parent
      ? replace(
          current,
          parent,
          withAttrs(
            current,
            parent,
            { count: items.length + 1 },
            current.source.slice(parent.openEnd, parent.closeStart) + value,
          ),
        )
      : setChild(current, "tableParts", ss("tableParts", value, { count: 1 }, xml.root.uri)),
  );
}
