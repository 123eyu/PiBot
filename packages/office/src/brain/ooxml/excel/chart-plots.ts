import type { OfficePackage } from "../package.ts";
import { seriesGroups } from "./chart-series.ts";
import { type ChartOp, ct, val } from "./chart-xml.ts";
export function plots(pkg: OfficePackage, config: ChartOp["chart"]) {
  const { groups } = seriesGroups(pkg, config);
  if (config.kind === "combo" && groups.size < 2) throw new Error("office_invalid");
  return Array.from(groups)
    .map(([kind, series]) => {
      const axis =
        kind !== "pie" && kind !== "doughnut" ? val("axId", 48650112) + val("axId", 48672768) : "";
      if (kind === "column" || kind === "bar")
        return ct(
          "barChart",
          val("barDir", kind === "bar" ? "bar" : "col") +
            val("grouping", "clustered") +
            val("varyColors", false) +
            series.join("") +
            val("gapWidth", 150) +
            val("overlap", 0) +
            axis,
        );
      if (kind === "line")
        return ct(
          "lineChart",
          val("grouping", "standard") +
            val("varyColors", false) +
            series.join("") +
            val("marker", true) +
            val("smooth", false) +
            axis,
        );
      if (kind === "area")
        return ct(
          "areaChart",
          val("grouping", "standard") + val("varyColors", false) + series.join("") + axis,
        );
      if (kind === "scatter")
        return ct(
          "scatterChart",
          val("scatterStyle", "lineMarker") + val("varyColors", false) + series.join("") + axis,
        );
      return ct(
        kind === "pie" ? "pieChart" : "doughnutChart",
        val("varyColors", true) +
          series.join("") +
          val("firstSliceAng", 0) +
          (kind === "doughnut" ? val("holeSize", 50) : ""),
      );
    })
    .join("");
}
