import type { OfficePackage } from "../package.ts";
import { axes } from "./chart-axes.ts";
import { plots } from "./chart-plots.ts";
import { A, C, type ChartOp, ct, R, title, val } from "./chart-xml.ts";
import { book } from "./model.ts";
import { unique } from "./xml-edit.ts";
export function chartXml(pkg: OfficePackage, config: ChartOp["chart"]) {
  if ((config.kind === "pie" || config.kind === "doughnut") && config.series.length !== 1)
    throw new Error("office_invalid");
  const plotXml = plots(pkg, config);
  const axis =
    config.kind === "pie" || config.kind === "doughnut"
      ? ""
      : axes(config, config.kind === "scatter");
  const legend =
    config.legend === "none"
      ? ""
      : ct(
          "legend",
          val("legendPos", { right: "r", left: "l", top: "t", bottom: "b" }[config.legend]) +
            ct("layout") +
            val("overlay", false),
        );
  return ct(
    "chartSpace",
    val(
      "date1904",
      ["1", "true"].includes(unique(book(pkg).xml.root, "workbookPr")?.attrs.get("date1904") ?? ""),
    ) +
      val("lang", "en-US") +
      val("roundedCorners", false) +
      ct(
        "chart",
        (config.title ? title(config.title) : val("autoTitleDeleted", true)) +
          ct("plotArea", ct("layout") + plotXml + axis) +
          legend +
          val("plotVisOnly", true) +
          val("dispBlanksAs", "gap"),
      ),
    { "xmlns:c": C, "xmlns:a": A, "xmlns:r": R },
  );
}
