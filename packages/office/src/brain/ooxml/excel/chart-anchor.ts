import { A, C, type ChartOp, ct, R, XDR } from "./chart-xml.ts";
import { tag } from "./xml-edit.ts";
export function anchor(op: ChartOp, id: number, rel: string) {
  const pos = (name: string, col: number, row: number) =>
    tag(
      `xdr:${name}`,
      tag("xdr:col", String(col)) +
        tag("xdr:colOff", "0") +
        tag("xdr:row", String(row)) +
        tag("xdr:rowOff", "0"),
    );
  const p = op.anchor;
  if (p.column + p.widthColumns > 16384 || p.row + p.heightRows > 1048576)
    throw new Error("office_invalid");
  const frame = tag(
    "xdr:graphicFrame",
    tag(
      "xdr:nvGraphicFramePr",
      tag("xdr:cNvPr", "", { id, name: op.name }) + tag("xdr:cNvGraphicFramePr"),
    ) +
      tag("xdr:xfrm", tag("a:off", "", { x: 0, y: 0 }) + tag("a:ext", "", { cx: 0, cy: 0 })) +
      tag("a:graphic", tag("a:graphicData", ct("chart", "", { "r:id": rel }), { uri: C })),
    { macro: "" },
  );
  return tag(
    "xdr:twoCellAnchor",
    pos("from", p.column - 1, p.row - 1) +
      pos("to", p.column - 1 + p.widthColumns, p.row - 1 + p.heightRows) +
      frame +
      tag("xdr:clientData"),
    { "xmlns:xdr": XDR, "xmlns:a": A, "xmlns:c": C, "xmlns:r": R },
  );
}
