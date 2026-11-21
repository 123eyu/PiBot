import type { OfficePackage } from "../package.ts";
import { escapeXml } from "../xml.ts";
import { type ChartOp, ct, val } from "./chart-xml.ts";
import { reference, values } from "./model.ts";
import { tag } from "./xml-edit.ts";

function cache(pkg: OfficePackage, ref: { sheet: string; range: string }, numeric: boolean) {
  const data = values(pkg, ref);
  if (data.some((v) => numeric && v !== null && typeof v !== "number"))
    throw new Error("office_invalid");
  const pts = data
    .flatMap((value, i) =>
      value === null ? [] : [ct("pt", ct("v", escapeXml(String(value))), { idx: i })],
    )
    .join("");
  return {
    count: data.length,
    xml: ct(
      numeric ? "numRef" : "strRef",
      ct("f", escapeXml(reference(ref))) +
        ct(
          numeric ? "numCache" : "strCache",
          (numeric ? ct("formatCode", "General") : "") + val("ptCount", data.length) + pts,
        ),
    ),
  };
}
export function seriesGroups(pkg: OfficePackage, config: ChartOp["chart"]) {
  const groups = new Map<string, string[]>();
  let total = 0;
  config.series.forEach((series, i) => {
    const kind = config.kind === "combo" ? series.kind : config.kind;
    if (!kind || (config.kind !== "combo" && series.kind !== undefined))
      throw new Error("office_invalid");
    if (config.kind !== "scatter" && series.xValues) throw new Error("office_invalid");
    const y = cache(pkg, series.values, true);
    total += y.count;
    const xref = config.kind === "scatter" ? series.xValues : series.categories;
    if (!xref) throw new Error("office_invalid");
    const x = cache(pkg, xref, config.kind === "scatter");
    total += x.count;
    if (x.count !== y.count || total > 20000) throw new Error("office_invalid");
    const shape =
      kind === "scatter"
        ? ct("spPr", tag("a:ln", tag("a:noFill")))
        : series.color && kind !== "pie" && kind !== "doughnut"
          ? ct(
              "spPr",
              tag("a:solidFill", tag("a:srgbClr", "", { val: series.color })) +
                (kind === "line"
                  ? tag("a:ln", tag("a:solidFill", tag("a:srgbClr", "", { val: series.color })))
                  : ""),
            )
          : "";
    const body =
      val("idx", i) +
      val("order", i) +
      ct("tx", ct("v", escapeXml(series.name))) +
      shape +
      (kind === "line" ? ct("marker", val("symbol", "none")) : "") +
      (kind === "scatter"
        ? ct(
            "marker",
            val("symbol", "circle") +
              val("size", 5) +
              (series.color
                ? ct("spPr", tag("a:solidFill", tag("a:srgbClr", "", { val: series.color })))
                : ""),
          ) +
          ct("xVal", x.xml) +
          ct("yVal", y.xml)
        : ct("cat", x.xml) + ct("val", y.xml)) +
      (kind === "line" || kind === "scatter" ? val("smooth", false) : "");
    const list = groups.get(kind) ?? [];
    list.push(ct("ser", body));
    groups.set(kind, list);
  });
  return { groups };
}
