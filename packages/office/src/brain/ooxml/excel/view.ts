import type { ExcelOperation } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import type { Element, XmlPart } from "../xml.ts";
import { address, area, columnName, overlaps, sheetPart } from "./model.ts";
import { assertNoTableOverlap } from "./table-index.ts";
import { children, raw, replace, setChild, ss, unique, withAttrs } from "./xml-edit.ts";

export function merge(pkg: OfficePackage, op: Extract<ExcelOperation, { op: "excel_merge" }>) {
  const a = area(op.range),
    { part, xml } = sheetPart(pkg, op.sheet),
    container = unique(xml.root, "mergeCells"),
    items = container ? children(container, "mergeCell") : [];
  if (op.merge) assertNoTableOverlap(pkg, part, op.range);
  const intersect = items.filter((n) =>
    overlaps(a, area(n.attrs.get("ref") ?? "", Number.MAX_SAFE_INTEGER)),
  );
  if (intersect.some((n) => area(n.attrs.get("ref") ?? "", Number.MAX_SAFE_INTEGER).ref !== a.ref))
    throw new Error("office_target_ambiguous");
  if (op.merge) {
    const data = unique(xml.root, "sheetData");
    if (data)
      for (const row of children(data, "row"))
        for (const cell of children(row, "c")) {
          const c = address(cell.attrs.get("r") ?? "");
          if (
            c.row < a.firstRow ||
            c.row > a.lastRow ||
            c.column < a.firstColumn ||
            c.column > a.lastColumn ||
            (c.row === a.firstRow && c.column === a.firstColumn)
          )
            continue;
          if (cell.children.some((n) => n.uri === cell.uri && ["v", "is", "f"].includes(n.name)))
            throw new Error("office_target_ambiguous");
        }
  }
  const kept = items.filter((n) => !intersect.includes(n)).map((n) => raw(xml, n));
  const extras =
    container?.children
      .filter((n) => n.uri !== container.uri || n.name !== "mergeCell")
      .map((n) => raw(xml, n)) ?? [];
  if (op.merge) kept.push(ss("mergeCell", "", { ref: a.ref }, xml.root.uri));
  if (!kept.length && extras.length) throw new Error("office_unsupported");
  const body = kept.join("") + extras.join("");
  pkg.replaceXml(
    part,
    setChild(
      xml,
      "mergeCells",
      body
        ? container
          ? withAttrs(xml, container, { count: kept.length }, body)
          : ss("mergeCells", body, { count: kept.length }, xml.root.uri)
        : "",
    ),
  );
}
export function view(pkg: OfficePackage, op: Extract<ExcelOperation, { op: "excel_view" }>) {
  const { part } = sheetPart(pkg, op.sheet);
  if (op.frozenRows !== undefined || op.frozenColumns !== undefined) {
    freeze(pkg, part, op);
  }
  if (op.autoFilter !== undefined) {
    const xml = pkg.xml(part);
    const ref = op.autoFilter === false ? undefined : area(op.autoFilter).ref;
    if (ref) assertNoTableOverlap(pkg, part, ref);
    pkg.replaceXml(
      part,
      setChild(xml, "autoFilter", ref ? ss("autoFilter", "", { ref }, xml.root.uri) : ""),
    );
  }
}

function freeze(
  pkg: OfficePackage,
  part: string,
  op: Extract<ExcelOperation, { op: "excel_view" }>,
) {
  const xml = pkg.xml(part),
    views = unique(xml.root, "sheetViews"),
    view = views && unique(views, "sheetView");
  if (views && !view) throw new Error("office_invalid");
  const body = freezeBody(xml, view, op);
  const changed = view
    ? withAttrs(xml, view, {}, body)
    : ss("sheetView", body, { workbookViewId: 0 }, xml.root.uri);
  pkg.replaceXml(
    part,
    view
      ? replace(xml, view, changed)
      : setChild(xml, "sheetViews", ss("sheetViews", changed, {}, xml.root.uri)),
  );
}

function freezeBody(
  xml: XmlPart,
  view: Element | undefined,
  op: Extract<ExcelOperation, { op: "excel_view" }>,
) {
  const previous = view && unique(view, "pane");
  const frozen = previous?.attrs.get("state")?.startsWith("frozen");
  const r = op.frozenRows ?? (frozen ? Number(previous?.attrs.get("ySplit") ?? 0) : 0),
    c = op.frozenColumns ?? (frozen ? Number(previous?.attrs.get("xSplit") ?? 0) : 0),
    cell = `${columnName(c + 1)}${r + 1}`,
    pane = r && c ? "bottomRight" : r ? "bottomLeft" : "topRight";
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= 1048576 || c >= 16384)
    throw new Error("office_invalid");
  const generated =
    r || c
      ? ss(
          "pane",
          "",
          {
            xSplit: c || undefined,
            ySplit: r || undefined,
            topLeftCell: cell,
            activePane: pane,
            state: "frozen",
          },
          xml.root.uri,
        )
      : "";
  let body =
    generated +
    ss(
      "selection",
      "",
      { pane: r || c ? pane : undefined, activeCell: cell, sqref: cell },
      xml.root.uri,
    );
  if (view) {
    const parts = view.children
      .filter((n) => n.uri !== view.uri || !["pane", "selection"].includes(n.name))
      .map((n) => raw(xml, n));
    body += parts.join("");
  }
  return body;
}
