import type { PresentationObject } from "@pibot/protocol-base/office-content";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import { DOC_REL, OfficePackage } from "../package.ts";
import { escapeXml } from "../xml.ts";
import { chartType, type PresentationParts, workbookType } from "./parts.ts";
import type { Theme } from "./themes.ts";

export type ChartObject = Extract<PresentationObject, { type: "chart" }>;
/** Keep the chart library for native chart XML and fixed Sheet1 range conventions. */
export async function addNativeChart(
  parts: PresentationParts,
  input: ChartObject,
  theme: Theme,
  ordinal: number,
) {
  // The library writes font names directly into some XML attributes.
  const font = (name: string) => (/^[\p{L}\p{N} ._+-]{1,80}$/u.test(name) ? name : "Arial");
  const heading = font(theme.heading);
  const body = font(theme.body);
  for (const value of [
    input.title,
    input.xAxisTitle,
    input.yAxisTitle,
    ...input.categories,
    ...input.series.map(({ name }) => name),
  ])
    if (typeof value === "string") escapeXml(value); // Reject invalid XML characters before calling the chart library.
  const ppt = new PptxGenJS();
  const slide = ppt.addSlide();
  ppt.theme = { headFontFace: heading, bodyFontFace: body };
  const kind = (type: string) =>
    type === "column" || type === "bar"
      ? ppt.ChartType.bar
      : type === "line"
        ? ppt.ChartType.line
        : type === "area"
          ? ppt.ChartType.area
          : type === "pie"
            ? ppt.ChartType.pie
            : type === "doughnut"
              ? ppt.ChartType.doughnut
              : ppt.ChartType.scatter;
  const chartColors = input.series.map(
    (series, i) => series.color ?? theme.colors[i % 6] ?? theme.ink,
  );
  const options: PptxGenJS.IChartOpts = {
    x: 0,
    y: 0,
    w: 10,
    h: 5.625,
    chartColors:
      input.kind === "pie" || input.kind === "doughnut"
        ? input.series[0]?.color
          ? [input.series[0].color]
          : theme.colors
        : chartColors,
    barDir: input.kind === "bar" ? "bar" : "col",
    barGrouping: "clustered",
    title: input.title,
    showTitle: !!input.title,
    showLegend: input.legend ?? input.series.length > 1,
    titleColor: theme.ink,
    titleFontFace: heading,
    titleFontSize: 16,
    legendColor: theme.ink,
    legendFontFace: body,
    legendFontSize: 11,
    catAxisLabelColor: theme.ink,
    valAxisLabelColor: theme.ink,
    catAxisLabelFontFace: body,
    valAxisLabelFontFace: body,
    catAxisLabelFontSize: 11,
    valAxisLabelFontSize: 11,
    catAxisTitle: input.xAxisTitle,
    valAxisTitle: input.yAxisTitle,
    showCatAxisTitle: !!input.xAxisTitle,
    showValAxisTitle: !!input.yAxisTitle,
    catAxisTitleColor: theme.ink,
    valAxisTitleColor: theme.ink,
    catAxisTitleFontFace: body,
    valAxisTitleFontFace: body,
    catAxisTitleFontSize: 12,
    valAxisTitleFontSize: 12,
    chartArea: { fill: { color: theme.background } },
    plotArea: { fill: { color: theme.background } },
    showValue: false,
    valGridLine: { color: theme.paper, size: 1 },
    ...(input.kind === "scatter" ? { lineDataSymbol: "circle", lineSize: 0 } : {}),
  };
  const series = input.series.map((item) => ({
    name: item.name,
    labels: input.categories.map(String),
    values: [...item.values],
  }));
  if (input.kind === "combo") {
    // In 4.0.1 multi-chart reads the second argument as options despite the overload declaration.
    const addMulti = slide.addChart as unknown as (
      types: PptxGenJS.IChartMulti[],
      options: PptxGenJS.IChartOpts,
    ) => void;
    addMulti.call(
      slide,
      input.series.map((item, i) => ({
        type: kind(item.kind ?? "column"),
        data: [series[i] ?? {}],
        options: {
          chartColors: [chartColors[i] ?? theme.ink],
          barDir: "col",
          barGrouping: "clustered",
        },
      })),
      options,
    );
  } else {
    const values =
      input.kind === "scatter"
        ? [{ name: input.xAxisTitle ?? "X", values: input.categories.map(Number) }, ...series]
        : series;
    slide.addChart(kind(input.kind), values, options);
  }
  const bytes = await ppt.write({ outputType: "uint8array", compression: true });
  if (!(bytes instanceof Uint8Array)) throw new Error("office_invalid");
  const pkg = await OfficePackage.open(bytes);
  const names = [...pkg.names()].filter((name) => /^ppt\/charts\/chart\d+\.xml$/u.test(name));
  if (names.length !== 1 || !names[0]) throw new Error("office_invalid");
  const source = names[0];
  const rels = pkg.relationships(source);
  const workbook = rels[0];
  if (rels.length !== 1 || !workbook?.target || workbook.type !== `${DOC_REL}/package`)
    throw new Error("office_invalid");
  const chart = pkg.readPart(source);
  if (!chart || !pkg.has(workbook.target)) throw new Error("office_invalid");
  // pptxgenjs 4.0.1 serializes category-series zeros as blank cells in its donor workbook.
  // Keep the same fixed Sheet1 address grid, but use typed cells so 0 and strings survive Edit Data.
  const data = await writeChartWorkbook(input);
  const part = `${parts.root}/charts/chart${ordinal}.xml`;
  const embedding = `${parts.root}/embeddings/workbook${ordinal}.xlsx`;
  parts.part(part, chartType, chart);
  parts.part(embedding, workbookType, data);
  parts.relate(part, "package", embedding, { id: workbook.id });
  return part;
}

async function writeChartWorkbook(input: ChartObject) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  const scatter = input.kind === "scatter";
  sheet.addRow([
    scatter ? (input.xAxisTitle ?? "X") : "Category",
    ...input.series.map(({ name }) => name),
  ]);
  for (const [index, category] of input.categories.entries()) {
    sheet.addRow([
      scatter ? Number(category) : String(category),
      ...input.series.map(({ values }) => values[index]),
    ]);
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
