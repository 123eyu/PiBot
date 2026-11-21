import { hasNamespace } from "../namespaces.ts";
import type { OfficePackage } from "../package.ts";
import { child, children, counted, related, relId, required, type SchemaIssue } from "../schema.ts";
import { area } from "./model.ts";
import { cacheFields, fieldItems, index, validateCache } from "./validate-cache.ts";
import { bookOrder } from "./xml-edit.ts";

export function validatePivotPart(
  pkg: OfficePackage,
  part: string,
  type: string | undefined,
  add: SchemaIssue,
) {
  const root = pkg.xml(part).root;
  if (!hasNamespace("xlsx", root.uri)) return;
  const kind = root.name === "pivotTableDefinition" ? "pivotTable" : root.name;
  if (
    ["pivotTable", "pivotCacheDefinition", "pivotCacheRecords"].includes(kind) &&
    type !== `application/vnd.openxmlformats-officedocument.spreadsheetml.${kind}+xml`
  )
    add("invalid_content_types");
  if (root.name === "worksheet" && child(root, "pivotTableDefinition"))
    add("invalid_schema", "worksheet.inline-pivot");
  if (root.name === "workbook") {
    let last = -1;
    for (const node of root.children.filter((node) => node.uri === root.uri)) {
      const rank = bookOrder.indexOf(node.name);
      if (rank >= 0) {
        if (rank < last) add("invalid_schema", "workbook.child-order");
        last = rank;
      }
    }
    const caches = child(root, "pivotCaches"),
      ids = new Set<string>();
    for (const entry of caches ? children(caches, "pivotCache") : []) {
      const id = entry.attrs.get("cacheId");
      if (!index(id, 4294967296) || ids.has(id ?? "")) add("invalid_schema", "workbook.cache-id");
      ids.add(id ?? "");
      if (!relId(entry) || related(pkg, part, "pivotCacheDefinition", relId(entry)).length !== 1)
        add("missing_relationship");
    }
  }
  if (root.name === "pivotCacheDefinition") validateCache(pkg, part, root, add);
  if (root.name !== "pivotTableDefinition") return;
  // CT_pivotTableDefinition has cacheId, never a relationship-namespace id.
  if (relId(root)) add("invalid_schema", "pivot.relationship-id");
  required(root, ["location"], add);
  if (
    !root.attrs.get("name") ||
    !root.attrs.has("dataCaption") ||
    !index(root.attrs.get("cacheId"), 4294967296)
  )
    add("invalid_schema", "pivot.required-attributes");
  const cache = related(pkg, part, "pivotCacheDefinition");
  if (cache.length !== 1 || !cache[0]?.target) {
    add("missing_relationship");
    return;
  }
  const cachePart = cache[0].target;
  const fields = cacheFields(pkg, cachePart);
  const workbook = pkg.mainPart(),
    caches = child(pkg.xml(workbook).root, "pivotCaches");
  if (
    !caches?.children.some(
      (entry) =>
        entry.attrs.get("cacheId") === root.attrs.get("cacheId") &&
        related(pkg, workbook, "pivotCacheDefinition", relId(entry)).some(
          (rel) => rel.target === cachePart,
        ),
    )
  )
    add("missing_relationship");
  const fieldList = counted(root, "pivotFields", add),
    pivots = fieldList ? children(fieldList, "pivotField") : [];
  if (pivots.length !== fields.length) add("invalid_schema", "pivot.field-count", [cachePart]);
  for (const name of ["rowFields", "colFields", "rowItems", "colItems", "pageFields", "dataFields"])
    counted(root, name, add);
  pivots.forEach((field, i) => {
    const items = counted(field, "items", add);
    if (field.attrs.has("axis") && (!items || !children(items, "item").length))
      add("invalid_schema", "pivot.axis-items");
    // Real Excel refuses a page field whose items do not close with the default item.
    if (
      field.attrs.get("axis") === "axisPage" &&
      !["0", "false"].includes(field.attrs.get("defaultSubtotal") ?? "1") &&
      items &&
      children(items, "item").at(-1)?.attrs.get("t") !== "default"
    )
      add("invalid_schema", "pivot.page-default-item");
    for (const item of items ? children(items, "item") : [])
      if (
        item.attrs.has("x") &&
        !["1", "true"].includes(item.attrs.get("f") ?? "0") &&
        !index(item.attrs.get("x"), fields[i] ? (fieldItems(fields[i])?.children.length ?? 0) : 0)
      )
        add("invalid_schema", "pivot.shared-item-index", [cachePart]);
  });
  for (const [list, axis] of [
    ["rowFields", "axisRow"],
    ["colFields", "axisCol"],
    ["pageFields", "axisPage"],
  ]) {
    const entry = child(root, list as string);
    for (const field of entry?.children ?? []) {
      const value = field.attrs.get(list === "pageFields" ? "fld" : "x");
      if (value === "-2" && list !== "pageFields") continue;
      if (!index(value, fields.length) || pivots[Number(value)]?.attrs.get("axis") !== axis)
        add("invalid_schema", `pivot.field-axis:${list}`, [cachePart]);
    }
  }
  for (const field of child(root, "dataFields")?.children ?? [])
    if (
      !index(field.attrs.get("fld"), fields.length) ||
      !["1", "true"].includes(pivots[Number(field.attrs.get("fld"))]?.attrs.get("dataField") ?? "")
    )
      add("invalid_schema", "pivot.data-field");
  for (const [axes, items] of [
    ["rowFields", "rowItems"],
    ["colFields", "colItems"],
  ]) {
    const axisFields = child(root, axes as string)?.children ?? [];
    for (const item of child(root, items as string)?.children ?? []) {
      const repeated = Number(item.attrs.get("r") ?? "0");
      const dataCount = child(root, "dataFields")?.children.length ?? 0;
      if (
        !Number.isInteger(repeated) ||
        repeated < 0 ||
        repeated > axisFields.length ||
        (dataCount > 0 && !index(item.attrs.get("i") ?? "0", dataCount))
      )
        add("invalid_schema", `pivot.item-offset:${items}`);
      if (item.attrs.get("t") === "grand") continue;
      children(item, "x").forEach((x, i) => {
        const fld = axisFields[i + repeated]?.attrs.get("x");
        if (fld === "-2" && !index(x.attrs.get("v") ?? "0", dataCount))
          add("invalid_schema", `pivot.measure-index:${items}`);
        const pivotField = pivots[Number(fld)];
        if (
          fld !== undefined &&
          fld !== "-2" &&
          !index(
            x.attrs.get("v") ?? "0",
            (pivotField ? child(pivotField, "items") : undefined)?.children.length ?? 0,
          )
        )
          add("invalid_schema", `pivot.axis-item-index:${items}`);
      });
    }
  }
  const location = child(root, "location");
  if (location) {
    const range = area(location.attrs.get("ref") ?? "", Number.MAX_SAFE_INTEGER);
    if (Number(location.attrs.get("firstHeaderRow")) > Number(location.attrs.get("firstDataRow")))
      add("invalid_schema", "pivot.location-header");
    for (const [attr, size] of [
      ["firstHeaderRow", range.lastRow - range.firstRow + 1],
      ["firstDataRow", range.lastRow - range.firstRow + 1],
      ["firstDataCol", range.lastColumn - range.firstColumn + 1],
    ] as const)
      if (!index(location.attrs.get(attr), size))
        add("invalid_schema", `pivot.location-bound:${attr}`);
  }
}
