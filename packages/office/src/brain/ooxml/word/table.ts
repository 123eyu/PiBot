import { one } from "../locate.ts";
import type { Element, XmlPart } from "../xml.ts";
import type { WordDocument, WordOperation } from "./document.ts";

type TableOperation = Extract<WordOperation, { op: "word_table" }>;
function readTable(d: WordDocument, index: number) {
  const xml = d.pkg.xml(d.main),
    table = one(d.all(xml, "tbl").slice(index - 1, index));
  return { xml, table, rows: table.children.filter((n) => n.uri === d.uri && n.name === "tr") };
}
export function tableWord(d: WordDocument, op: TableOperation) {
  const { xml, table } = readTable(d, op.table),
    changes: Record<string, string> = {};
  if (op.style) changes.tblStyle = d.tag("tblStyle", { val: op.style });
  if (op.align) changes.jc = d.tag("jc", { val: d.alignment(op.align) });
  d.props(d.main, xml, table, "tblPr", changes);
  if (op.repeatHeader !== undefined) {
    const { xml, rows } = readTable(d, op.table),
      row = one(rows.slice(0, 1));
    d.props(d.main, xml, row, "trPr", {
      tblHeader: d.tag("tblHeader", { val: op.repeatHeader ? "1" : "0" }),
    });
  }
  tableWidths(d, op);
  tableAlignment(d, op);
  mergeTableCells(d, op);
}
function tableWidths(d: WordDocument, op: TableOperation) {
  let { xml, table, rows } = readTable(d, op.table);
  const refresh = () => {
    ({ xml, table, rows } = readTable(d, op.table));
    return rows;
  };
  const widths = op.widths;
  if (widths) {
    const grid = d.child(table, "tblGrid"),
      value = d.tag("tblGrid", {}, widths.map((w) => d.tag("gridCol", { w })).join(""));
    if (grid) d.replace(d.main, xml, grid, value);
    else {
      const pr = d.child(table, "tblPr");
      const at = pr?.end ?? table.openEnd;
      d.patch(d.main, xml, [{ start: at, end: at, value }]);
    }
    rows = refresh();
    for (let r = rows.length - 1; r >= 0; r--) {
      const cells = one(rows.slice(r, r + 1)).children.filter(
        (n) => n.uri === d.uri && n.name === "tc",
      );
      if (cells.length !== widths.length) throw new Error("office_unsupported");
      const edits = cells.map((cell, i) => ({
        start: cell.start,
        end: cell.end,
        value: d.withProps(xml, cell, "tcPr", {
          tcW: d.tag("tcW", { w: widths[i] as number, type: "dxa" }),
        }),
      }));
      d.patch(d.main, xml, edits);
      rows = refresh();
    }
  }
}
function tableAlignment(d: WordDocument, op: TableOperation) {
  const { xml, rows } = readTable(d, op.table);
  if (op.cellAlign || op.verticalAlign) {
    const edits: { start: number; end: number; value: string }[] = [];
    for (const row of rows)
      for (const cell of row.children.filter((n) => n.uri === d.uri && n.name === "tc")) {
        if (op.verticalAlign) {
          const pr = d.child(cell, "tcPr"),
            value = d.propertyValue(xml, cell, "tcPr", {
              vAlign: d.tag("vAlign", { val: op.verticalAlign }),
            });
          edits.push({ start: pr?.start ?? cell.openEnd, end: pr?.end ?? cell.openEnd, value });
        }
        if (op.cellAlign)
          for (const p of cell.children.filter((n) => n.uri === d.uri && n.name === "p"))
            edits.push({
              start: p.start,
              end: p.end,
              value: d.withProps(xml, p, "pPr", {
                jc: d.tag("jc", { val: d.alignment(op.cellAlign) }),
              }),
            });
      }
    d.patch(d.main, xml, edits);
  }
}
function mergeTableCells(d: WordDocument, op: TableOperation) {
  const occupied = new Set<string>();
  for (const merge of [...(op.merges ?? [])].sort((a, b) => b.column - a.column || b.row - a.row)) {
    const { xml, rows } = readTable(d, op.table);
    const top = merge.row - 1,
      left = merge.column - 1;
    if (top + merge.rows > rows.length) throw new Error("office_target_ambiguous");
    const selected = rows
      .slice(top, top + merge.rows)
      .map((row) => row.children.filter((n) => n.uri === d.uri && n.name === "tc"));
    for (let r = 0; r < merge.rows; r++)
      for (let c = left; c < left + merge.columns; c++) {
        const key = `${top + r}:${c}`,
          cell = selected[r]?.[c];
        if (
          !cell ||
          occupied.has(key) ||
          ["gridSpan", "vMerge", "hMerge"].some((name) => {
            const p = d.child(cell, "tcPr");
            return p && d.child(p, name);
          })
        )
          throw new Error("office_unsupported");
        occupied.add(key);
      }
    const edits = [];
    for (let r = 0; r < merge.rows; r++) {
      const group = one(selected.slice(r, r + 1)).slice(left, left + merge.columns),
        cell = one(group.slice(0, 1));
      const raw = mergedCell(d, xml, selected, left, merge.columns, merge.rows, r, op.widths);
      edits.push({ start: cell.start, end: one(group.slice(-1)).end, value: raw });
    }
    d.patch(d.main, xml, edits);
  }
}

function mergedCell(
  d: WordDocument,
  xml: XmlPart,
  selected: Element[][],
  left: number,
  columns: number,
  height: number,
  r: number,
  widths: number[] | undefined,
) {
  const cell = one(one(selected.slice(r, r + 1)).slice(left, left + 1));
  const grid = columns > 1 ? d.tag("gridSpan", { val: columns }) : "",
    vmerge = height > 1 ? d.tag("vMerge", r === 0 ? { val: "restart" } : {}) : "";
  // Move every original cell's paragraphs into the surviving cell; never silently discard text.
  let raw = d.withProps(xml, cell, "tcPr", { gridSpan: grid, vMerge: vmerge });
  if (widths) {
    const total = widths.slice(left, left + columns).reduce((sum, n) => sum + n, 0);
    raw = d.withProps(xml, cell, "tcPr", {
      gridSpan: grid,
      vMerge: vmerge,
      tcW: d.tag("tcW", { w: total, type: "dxa" }),
    });
  }
  if (r === 0) {
    const extra = selected
      .flatMap((row, ri) => row.slice(left + (ri === 0 ? 1 : 0), left + columns))
      .map((c) =>
        c.children
          .filter((n) => !(n.uri === d.uri && n.name === "tcPr"))
          .map((n) => d.raw(xml, n))
          .join(""),
      )
      .join("");
    const close = raw.lastIndexOf("</");
    raw = raw.slice(0, close) + extra + raw.slice(close);
  } else {
    const start = raw.indexOf(">") + 1,
      close = raw.lastIndexOf("</"),
      prStart = raw.indexOf("<w:tcPr", start),
      prEnd = raw.indexOf("</w:tcPr>", prStart) + "</w:tcPr>".length;
    if (prStart < 0 || prEnd < prStart) throw new Error("office_invalid");
    raw = raw.slice(0, prEnd) + d.tag("p", {}, "") + raw.slice(close);
  }
  return raw;
}
