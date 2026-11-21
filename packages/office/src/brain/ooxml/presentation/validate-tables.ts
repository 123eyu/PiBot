import { hasNamespace, tableUris } from "../namespaces.ts";
import { child, children, required, type SchemaIssue } from "../schema.ts";
import { type Element, elements } from "../xml.ts";

export function validateTables(root: Element, add: SchemaIssue) {
  for (const node of elements(root)) {
    if (!hasNamespace("drawingml", node.uri) || node.name !== "graphicData") continue;
    const table = child(node, "tbl");
    if (!table) continue;
    // XSD accepts arbitrary graphicData payloads; Office dispatches them by this exact URI.
    if (!(tableUris as readonly string[]).includes(node.attrs.get("uri") ?? ""))
      add("invalid_schema", "table.graphic-uri");
    required(table, ["tblGrid"], add);
    const grid = child(table, "tblGrid"),
      rows = children(table, "tr");
    const columns = grid ? children(grid, "gridCol") : [];
    if (!columns.length) add("invalid_schema", "table.grid-columns");
    for (const column of columns)
      if (!(Number(column.attrs.get("w")) >= 0)) add("invalid_schema", "table.column-width");
    for (const row of rows) {
      const cells = children(row, "tc");
      const span = cells.reduce(
        (count, cell) =>
          count +
          (["1", "true"].includes(cell.attrs.get("hMerge") ?? "0")
            ? 0
            : Number(cell.attrs.get("gridSpan") ?? "1")),
        0,
      );
      if (
        (cells.length !== columns.length && span !== columns.length) ||
        !(Number(row.attrs.get("h")) >= 0)
      )
        add("invalid_schema", "table.row-span-and-height");
    }
  }
}
