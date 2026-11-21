import type { OfficePackage } from "../package.ts";
import { child, children, counted, related, relId, required, type SchemaIssue } from "../schema.ts";
import type { Element } from "../xml.ts";
import { area } from "./model.ts";

export function index(value: string | undefined, size: number) {
  const n = Number(value);
  return value !== undefined && Number.isInteger(n) && n >= 0 && n < size;
}
export function cacheFields(pkg: OfficePackage, part: string) {
  const fields = child(pkg.xml(part).root, "cacheFields");
  return fields ? children(fields, "cacheField") : [];
}
export function fieldItems(field: Element) {
  const group = child(field, "fieldGroup");
  return (group && child(group, "groupItems")) ?? child(field, "sharedItems");
}

export function validateCache(pkg: OfficePackage, part: string, root: Element, add: SchemaIssue) {
  required(root, ["cacheSource", "cacheFields"], add);
  const fields = cacheFields(pkg, part);
  counted(root, "cacheFields", add);
  for (const field of fields) {
    const items = counted(field, "sharedItems", add);
    if (!items) continue;
    for (const [name, type, defaultValue] of [
      ["containsNumber", "n", false],
      ["containsString", "s", true],
      ["containsBlank", "m", false],
    ] as const) {
      const value = items.attrs.get(name);
      const enabled = value === undefined ? defaultValue : ["1", "true"].includes(value);
      if (!enabled && items.children.some((item) => item.name === type))
        add("invalid_schema", `cache.shared-type:${name}`);
    }
    const enabled = (name: string, fallback = false) =>
      items.attrs.has(name) ? ["1", "true"].includes(items.attrs.get(name) ?? "") : fallback;
    const kinds = new Set(
      items.children.filter((item) => item.name !== "m").map((item) => item.name),
    );
    if (
      (!enabled("containsSemiMixedTypes", true) && kinds.has("s")) ||
      (!enabled("containsMixedTypes") && kinds.size > 1)
    )
      add("invalid_schema", "cache.mixed-type-flags");
    for (const value of children(items, "n")) {
      const n = Number(value.attrs.get("v"));
      if (
        (enabled("containsInteger") && !Number.isInteger(n)) ||
        (items.attrs.has("minValue") && n < Number(items.attrs.get("minValue"))) ||
        (items.attrs.has("maxValue") && n > Number(items.attrs.get("maxValue")))
      )
        add("invalid_schema", "cache.numeric-metadata");
    }
  }
  const source = child(root, "cacheSource");
  if (source?.attrs.get("type") === "worksheet") {
    required(source, ["worksheetSource"], add);
    const worksheet = child(source, "worksheetSource");
    if (worksheet?.attrs.has("ref")) {
      area(worksheet.attrs.get("ref") ?? "", Number.MAX_SAFE_INTEGER);
      const sheets = child(pkg.xml(pkg.mainPart()).root, "sheets");
      if (
        !sheets?.children.some((sheet) => sheet.attrs.get("name") === worksheet.attrs.get("sheet"))
      )
        add("invalid_schema", "cache.source-sheet", [pkg.mainPart()]);
    }
  }
  const allRecords = related(pkg, part, "pivotCacheRecords");
  const records = related(pkg, part, "pivotCacheRecords", relId(root));
  if (
    (relId(root) || allRecords.length > 0) &&
    (!relId(root) || records.length !== 1 || allRecords.length !== 1)
  )
    add("missing_relationship");
  const recordsPart = records[0]?.target;
  if (recordsPart) {
    const rows = pkg.xml(recordsPart).root;
    if (
      rows.name !== "pivotCacheRecords" ||
      (rows.attrs.has("count") && Number(rows.attrs.get("count")) !== children(rows, "r").length) ||
      (root.attrs.has("recordCount") &&
        Number(root.attrs.get("recordCount")) !== children(rows, "r").length)
    )
      add("invalid_schema", "cache.record-count", [recordsPart]);
    const databaseFields = fields.filter(
      (field) => !["0", "false"].includes(field.attrs.get("databaseField") ?? "1"),
    );
    for (const row of children(rows, "r")) {
      if (row.children.length !== databaseFields.length)
        add("invalid_schema", "cache.record-width", [recordsPart]);
      row.children.forEach((value, i) => {
        const shared = databaseFields[i] ? child(databaseFields[i], "sharedItems") : undefined;
        // Inline values and shared indexes are different cache encodings, not interchangeable.
        if ((shared?.children.length ?? 0) > 0 && value.name !== "x")
          add("invalid_schema", "cache.record-encoding", [recordsPart]);
        if (value.name === "x" && !index(value.attrs.get("v"), shared?.children.length ?? 0))
          add("invalid_schema", "cache.record-index", [recordsPart]);
      });
    }
  }
}
