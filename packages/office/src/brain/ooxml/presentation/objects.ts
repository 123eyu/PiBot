import type { PresentationObject } from "@pibot/protocol-base/office-content";
import { addNativeChart } from "./charts.ts";
import { click, frame, link } from "./graphics.ts";
import { icon } from "./icons.ts";
import { image } from "./image.ts";
import type { ObjectContext } from "./object-context.ts";
import { C, fill, transform } from "./parts.ts";
import { smartartObject } from "./smartart.ts";
import { table } from "./table.ts";
import { textBody, textShape } from "./text.ts";
import type { Box, Theme } from "./themes.ts";

function contrastingText(hex: string) {
  const luminance = [0, 2, 4]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((sum, value, index) => sum + value * ([0.2126, 0.7152, 0.0722][index] ?? 0), 0);
  return luminance > 0.179 ? "000000" : "FFFFFF";
}
export function shape(
  id: number,
  name: string,
  box: Box,
  color: string,
  width: number,
  height: number,
  text = "",
  theme?: Theme,
  hyperlink?: string,
) {
  const properties = `<p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}">${click(hyperlink)}</p:cNvPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`;
  const geometry = `<a:prstGeom prst="${name}"><a:avLst/></a:prstGeom>`;
  const background = name === "line" ? "<a:noFill/>" : fill(color);
  const stroke = `<a:ln w="19050">${fill(color)}</a:ln>`;
  const body = text && theme ? shapeText(text, theme, color) : "";
  return `<p:sp>${properties}<p:spPr>${transform(box, width, height)}${geometry}${background}${stroke}</p:spPr>${body}</p:sp>`;
}

export async function nativeObject(input: PresentationObject, ctx: ObjectContext): Promise<string> {
  if (input.type === "image") return image(input, ctx);
  if (input.type === "table") return table(input, ctx);
  if (input.type === "icon") return icon(input, ctx);
  if (input.type === "text")
    return textShape(ctx.ids.next(), input.text, ctx.box, ctx.theme, ctx.width, ctx.height, {
      size: 18,
      color: ctx.theme.ink,
      hyperlink: link(ctx.parts, ctx.slide, input.link),
    });
  if (input.type === "smartart") return smartartObject(input, ctx);
  if (input.type === "shape")
    return shape(
      ctx.ids.next(),
      input.shape,
      ctx.box,
      input.color ?? ctx.theme.colors[0],
      ctx.width,
      ctx.height,
      input.text,
      ctx.theme,
      link(ctx.parts, ctx.slide, input.link),
    );
  const chart = await addNativeChart(ctx.parts, input, ctx.theme, ctx.ordinal);
  const id = ctx.parts.relate(ctx.slide, "chart", chart);
  return frame(
    ctx,
    `<a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="${id}"/></a:graphicData>`,
  );
}

function shapeText(text: string, theme: Theme, color: string) {
  const body = textBody(text, theme, {
    size: 18,
    color: contrastingText(color),
    centered: true,
    cell: true,
  });
  return `<p:txBody>${body}</p:txBody>`;
}
