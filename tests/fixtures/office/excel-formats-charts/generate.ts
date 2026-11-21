// Offline sample generation and structural acceptance; never opens user documents or Office apps.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createOffice } from "../../../../packages/office/src/brain/codecs/index.ts";
import {
  OfficePackage,
  editOoxml,
  validateOoxml,
} from "../../../../packages/office/src/brain/ooxml/index.ts";
import { values } from "../../../../packages/office/src/brain/ooxml/excel/model.ts";
import { children } from "../../../../packages/office/src/brain/ooxml/excel/xml-edit.ts";
import { elements } from "../../../../packages/office/src/brain/ooxml/xml.ts";
import { OfficeOperationsSchema } from "../../../../packages/protocol-base/src/office/ooxml.ts";

const source = await createOffice({
  kind: "xlsx",
  sheets: [
    {
      name: "Sales",
      rows: [
        ["Quarter", "Revenue", "Cost", "Margin"],
        ["Q1", 120, 80, { formula: "B2-C2", cachedValue: 40 }],
        ["Q2", 150, 90, { formula: "B3-C3", cachedValue: 60 }],
        ["Q3", 170, 110, { formula: "B4-C4", cachedValue: 60 }],
        ["Q4", 210, 130, { formula: "B5-C5", cachedValue: 80 }],
      ],
    },
    {
      name: "Lookup's",
      rows: [
        ["Status", "X", "Y"],
        ["Open", 1, 10],
        ["Closed", 2, 25],
        ["Pending", 3, 15],
      ],
    },
    { name: "Keep", rows: [["Untouched", 123]] },
  ],
});
const ref = (range: string) => ({ sheet: "Sales", range });
const operations: unknown[] = [
  {
    op: "excel_format",
    sheet: "Sales",
    range: "B2:D5",
    style: {
      numberFormat: "#,##0.00",
      alignment: { horizontal: "right" },
      border: { bottom: { style: "thin", color: "D0D0D0" } },
    },
  },
  {
    op: "excel_format",
    sheet: "Sales",
    range: "A1:D1",
    style: {
      font: { bold: true, color: "FFFFFF", size: 13 },
      fill: "163E64",
      alignment: { wrapText: true },
    },
  },
  {
    op: "excel_format",
    sheet: "Sales",
    range: "F1:H1",
    style: { font: { italic: true }, fill: "DDEEFF" },
  },
  {
    op: "excel_dimensions",
    sheet: "Sales",
    columns: [{ first: 1, last: 4, width: 20 }],
    rows: [
      { first: 1, last: 1, height: 32 },
      { first: 7, last: 7, height: 24 },
    ],
  },
  { op: "excel_merge", sheet: "Sales", range: "F1:H1" },
  { op: "excel_view", sheet: "Sales", frozenRows: 1, frozenColumns: 1 },
  {
    op: "excel_conditional_format",
    sheet: "Sales",
    range: "B2:B5",
    rule: { kind: "colorScale", colors: ["F8696B", "FFEB84", "63BE7B"] },
  },
  {
    op: "excel_conditional_format",
    sheet: "Sales",
    range: "C2:C5",
    rule: { kind: "dataBar", color: "4488CC" },
  },
  {
    op: "excel_conditional_format",
    sheet: "Sales",
    range: "D2:D5",
    rule: {
      kind: "cellIs",
      operator: "greaterThan",
      values: [50],
      style: { font: { bold: true }, fill: "99DD99" },
    },
  },
  {
    op: "excel_validation",
    sheet: "Sales",
    range: "F2:F5",
    validation: { kind: "list", values: ["Open", "Closed", "Pending"] },
  },
  {
    op: "excel_validation",
    sheet: "Sales",
    range: "G2:G5",
    validation: { kind: "decimal", operator: "between", values: [0, 1000] },
  },
  {
    op: "excel_validation",
    sheet: "Sales",
    range: "H2:H5",
    validation: { kind: "date", operator: "between", values: [45000, 50000] },
  },
  {
    op: "excel_validation",
    sheet: "Sales",
    range: "I2:I5",
    validation: { kind: "listRange", source: { sheet: "Lookup's", range: "A2:A4" } },
  },
  { op: "excel_defined_name", name: "SalesRevenue", source: ref("B2:B5") },
  {
    op: "excel_table",
    sheet: "Sales",
    range: "A1:D5",
    name: "SalesTable",
    columns: ["Quarter", "Revenue", "Cost", "Margin"],
  },
];
const kinds = ["column", "bar", "line", "pie", "doughnut", "area", "scatter", "combo"] as const;
for (const [i, kind] of kinds.entries())
  operations.push({
    op: "excel_chart",
    sheet: "Sales",
    name: `Sample ${kind}`,
    anchor: { column: 11 + (i % 2) * 12, row: 1 + Math.floor(i / 2) * 20 },
    chart: {
      kind,
      title: `${kind} — editable`,
      categoryAxisTitle: "Quarter / X",
      valueAxisTitle: "Revenue",
      series:
        kind === "scatter"
          ? [
              {
                name: "Points",
                values: { sheet: "Lookup's", range: "C2:C4" },
                xValues: { sheet: "Lookup's", range: "B2:B4" },
                color: "4477CC",
              },
            ]
          : kind === "combo"
            ? [
                {
                  name: "Revenue",
                  values: ref("B2:B5"),
                  categories: ref("A2:A5"),
                  kind: "column",
                  color: "4477CC",
                },
                {
                  name: "Cost",
                  values: ref("C2:C5"),
                  categories: ref("A2:A5"),
                  kind: "line",
                  color: "CC7744",
                },
              ]
            : [
                {
                  name: "Revenue",
                  values: ref("B2:B5"),
                  categories: ref("A2:A5"),
                  color: "4477CC",
                },
              ],
    },
  });
const result = await editOoxml(source, "xlsx", OfficeOperationsSchema.parse(operations), false);
assert.ok(result.bytes);
assert.equal(result.validation.serious, 0);
const pkg = await OfficePackage.open(result.bytes),
  original = await OfficePackage.open(source);
assert.equal((await validateOoxml(result.bytes, "xlsx")).serious, 0);
const before = await import("../../../../packages/office/src/brain/ooxml/excel/model.ts");
const keep = before.sheetPart(original, "Keep").part;
assert.deepEqual(pkg.readPart(keep), original.readPart(keep));
assert.deepEqual(values(pkg, ref("D2:D5")), [40, 60, 60, 80]);
const sheet = pkg.xml(before.sheetPart(pkg, "Sales").part);
assert.equal(children(sheet.root, "conditionalFormatting").length, 3);
assert.equal(children(sheet.root,"autoFilter").length,0);
const stylePart=Array.from(pkg.names()).find(n=>n.startsWith("xl/styles")&&n.endsWith(".xml"))!;
const dxfs=children(pkg.xml(stylePart).root,"dxfs")[0]!;
assert.ok(Array.from(elements(dxfs)).some(n=>n.name==="bgColor"&&n.attrs.get("rgb")==="FF99DD99"));
assert.equal(children(sheet.root, "dataValidations")[0]?.children.length, 4);
assert.equal(children(sheet.root, "tableParts")[0]?.children.length, 1);
assert.equal(
  Array.from(pkg.names()).filter((n) => /^xl\/charts\/chart\d+\.xml$/u.test(n)).length,
  8,
);
for (const part of pkg.names())
  if (/^xl\/charts\//u.test(part)) {
    const nodes = Array.from(elements(pkg.xml(part).root));
    assert.ok(nodes.some((n) => n.name === "f"));
    assert.ok(nodes.some((n) => n.name === "pt"));
  }
// Updating a named chart must preserve its part/relationship identity and every other chart.
const update = {
  op: "excel_chart",
  sheet: "Sales",
  name: "Sample column",
  anchor: { column: 11, row: 1 },
  chart: {
    kind: "column",
    title: "Updated title",
    legend: "right",
    series: [{ name: "Cost", values: ref("C2:C5"), categories: ref("A2:A5"), color: "228855" }],
  },
};
const updated = await editOoxml(
  result.bytes,
  "xlsx",
  OfficeOperationsSchema.parse([update]),
  false,
);
assert.ok(updated.bytes);
const updatedPkg = await OfficePackage.open(updated.bytes);
assert.equal(
  Array.from(updatedPkg.names()).filter((n) => /^xl\/charts\/chart\d+\.xml$/u.test(n)).length,
  8,
);
for (const part of pkg.names())
  if (/^xl\/charts\/chart[2-8]\.xml$/u.test(part))
    assert.deepEqual(updatedPkg.readPart(part), pkg.readPart(part));
for (const bad of [
  { op: "excel_merge", sheet: "Sales", range: "A1:B2" },
  { op: "excel_format", sheet: "Sales", range: "XFE1", style: { fill: "FFFFFF" } },
  { op: "excel_defined_name", name: "A1", source: ref("B2:B5") },
  {
    op: "excel_table",
    sheet: "Sales",
    range: "A1:D5",
    name: "SalesTable",
    columns: ["Quarter", "Revenue", "Cost", "Margin"],
  },
  {
    ...update,
    chart: {
      ...update.chart,
      series: [{ name: "Invalid", values: ref("A2:A5"), categories: ref("B2:B5") }],
    },
  },
])
  await assert.rejects(() =>
    editOoxml(result.bytes as Uint8Array, "xlsx", OfficeOperationsSchema.parse([bad]), false),
  );
assert.equal(
  OfficeOperationsSchema.safeParse([
    {
      ...update,
      chart: {
        ...update.chart,
        series: [
          { name: "External", values: { sheet: "Sales", range: "[external.xlsx]Sheet!A1" } },
        ],
      },
    },
  ]).success,
  false,
);
const require = createRequire(new URL("../../../../packages/office/package.json", import.meta.url));
const workbook = new (require("exceljs").Workbook)();
await workbook.xlsx.load(Buffer.from(updated.bytes));
const sales = workbook.getWorksheet("Sales");
assert.equal(sales.getCell("B2").numFmt, "#,##0.00");
assert.equal(sales.getCell("A1").font.bold, true);
assert.equal(sales.getCell("A1").fill.fgColor.argb, "FF163E64");
assert.equal(sales.getColumn(1).width, 20);
assert.equal(sales.getRow(1).height, 32);
assert.equal(sales.getCell("F1").isMerged, true);
assert.equal(sales.views[0].state, "frozen");
assert.equal(sales.getCell("F2").dataValidation.type, "list");
assert.equal(sales.getCell("H2").dataValidation.type, "date");
assert.ok(sales.getTable("SalesTable"));
assert.equal(sales.conditionalFormattings.length, 3);
const path = resolve(process.argv[2] ?? "tests/fixtures/office/excel-formats-charts/report.xlsx");
await mkdir(dirname(path), { recursive: true });
await writeFile(path, updated.bytes);
const unchanged = Array.from(original.names()).filter((part) =>
  Buffer.from(original.readPart(part) ?? []).equals(Buffer.from(updatedPkg.readPart(part) ?? [])),
).length;
console.log(
  JSON.stringify({
    sample: path,
    operations: operations.length,
    charts: 8,
    serious: 0,
    sourceParts: Array.from(original.names()).length,
    unchangedSourceParts: unchanged,
    sha256: createHash("sha256").update(updated.bytes).digest("hex"),
  }),
);
