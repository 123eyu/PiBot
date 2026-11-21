import { escapeXml as esc } from "../xml.ts";
import { fill, transform } from "./parts.ts";
import type { Placeholder } from "./template.ts";
import type { Box, Theme } from "./themes.ts";

export const placeholderXml = (ph: Placeholder | undefined) =>
  ph
    ? `<p:ph type="${esc(ph.type)}"${ph.index === undefined ? "" : ` idx="${esc(ph.index)}"`}/>`
    : "";

export function textBody(
  value: string,
  theme: Theme,
  options: {
    size: number;
    color: string;
    bold?: boolean;
    centered?: boolean;
    heading?: boolean;
    hyperlink?: string;
    cell?: boolean;
    inherit?: boolean;
  },
) {
  const { size, color, bold, centered, heading, hyperlink, cell, inherit } = options;
  const fonts = inherit
    ? ""
    : `<a:latin typeface="${esc(heading ? theme.heading : theme.body)}"/><a:ea typeface="${esc(theme.eastAsia)}"/><a:cs typeface="${esc(theme.body)}"/>`;
  const props = inherit ? "" : ` sz="${Math.round(size * 100)}"${bold ? ' b="1"' : ""}`;
  const style = `${inherit ? "" : fill(color)}${fonts}${hyperlink ? `<a:hlinkClick r:id="${esc(hyperlink)}"/>` : ""}`;
  const paragraphProps = inherit ? "" : paragraphProperties(centered, cell);
  const paras = value
    .split(/\r\n|\r|\n/u)
    .map((line) => textParagraph(line, paragraphProps, props, style))
    .join("");
  const body = inherit
    ? "<a:bodyPr/>"
    : `<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${cell ? "ctr" : "t"}"><a:normAutofit/></a:bodyPr>`;
  return `${body}<a:lstStyle/>${paras}`;
}
export function textShape(
  id: number,
  value: string,
  box: Box,
  theme: Theme,
  width: number,
  height: number,
  options: Parameters<typeof textBody>[2] & { placeholder?: Placeholder; background?: string },
) {
  const inherit = options.inherit && options.placeholder !== undefined;
  const nonVisual = options.placeholder
    ? '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
    : '<p:cNvSpPr txBox="1"/>';
  const geometry = inherit
    ? "<p:spPr/>"
    : `<p:spPr>${transform(box, width, height)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${options.background ? fill(options.background) : "<a:noFill/>"}<a:ln><a:noFill/></a:ln></p:spPr>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/>${nonVisual}<p:nvPr>${placeholderXml(options.placeholder)}</p:nvPr></p:nvSpPr>${geometry}<p:txBody>${textBody(value, theme, { ...options, inherit })}</p:txBody></p:sp>`;
}

function paragraphProperties(centered?: boolean, cell?: boolean) {
  return `<a:pPr algn="${centered ? "ctr" : "l"}"><a:spcAft><a:spcPts val="${cell ? 200 : 700}"/></a:spcAft></a:pPr>`;
}

function textParagraph(line: string, paragraphProps: string, props: string, style: string) {
  const language = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    line,
  )
    ? "zh-CN"
    : "en-US";
  const run = `<a:r><a:rPr lang="${language}"${props}>${style}</a:rPr><a:t>${esc(line)}</a:t></a:r>`;
  return `<a:p>${paragraphProps}${run}<a:endParaRPr${props}/></a:p>`;
}
