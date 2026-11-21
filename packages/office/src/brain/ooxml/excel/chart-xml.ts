import type { ExcelOperation } from "@pibot/protocol-base/office-ooxml";
import { escapeXml } from "../xml.ts";
import { tag } from "./xml-edit.ts";
export const C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
export const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export type ChartOp = Extract<ExcelOperation, { op: "excel_chart" }>;
export const ct = (
  name: string,
  body = "",
  attrs: Record<string, string | number | boolean | undefined> = {},
) => tag(`c:${name}`, body, attrs);
export const val = (name: string, value: string | number | boolean) => ct(name, "", { val: value });
function rich(text: string) {
  return (
    tag("a:bodyPr") +
    tag("a:lstStyle") +
    tag("a:p", tag("a:r", tag("a:rPr", "", { lang: "en-US" }) + tag("a:t", escapeXml(text))))
  );
}
export function title(text: string) {
  return ct("title", ct("tx", ct("rich", rich(text))) + ct("layout") + val("overlay", false));
}
