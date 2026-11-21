import { type ChartOp, ct, title, val } from "./chart-xml.ts";
export function axes(config: ChartOp["chart"], scatter: boolean) {
  const axis = (id: number, cross: number, position: string, valueAxis: boolean, text?: string) =>
    ct(
      valueAxis ? "valAx" : "catAx",
      val("axId", id) +
        ct("scaling", val("orientation", "minMax")) +
        val("delete", false) +
        val("axPos", position) +
        (valueAxis ? ct("majorGridlines") : "") +
        (text ? title(text) : "") +
        ct("numFmt", "", { formatCode: "General", sourceLinked: true }) +
        val("majorTickMark", "none") +
        val("minorTickMark", "none") +
        val("tickLblPos", "nextTo") +
        val("crossAx", cross) +
        val("crosses", "autoZero") +
        (valueAxis
          ? val("crossBetween", "between")
          : val("auto", true) + val("lblAlgn", "ctr") + val("lblOffset", 100)),
    );
  const horizontal = config.kind === "bar";
  return (
    axis(48650112, 48672768, horizontal ? "l" : "b", scatter, config.categoryAxisTitle) +
    axis(48672768, 48650112, horizontal ? "b" : "l", true, config.valueAxisTitle)
  );
}
