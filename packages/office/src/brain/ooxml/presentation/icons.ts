import type { PresentationObject } from "@pibot/protocol-base/office-content";
import { click, link } from "./graphics.ts";
import type { ObjectContext } from "./object-context.ts";
import { fill, transform } from "./parts.ts";
import { rect } from "./themes.ts";

const paths = {
  check: ["M 140 510 L 390 760 L 870 230"],
  arrow: ["M 100 500 L 900 500", "M 570 170 L 900 500 L 570 830"],
  chart: ["M 120 140 L 120 870 L 900 870", "M 260 720 L 440 490 L 630 610 L 850 230"],
  target: [
    "M 500 130 C 20 130 20 870 500 870 C 980 870 980 130 500 130 Z",
    "M 500 330 C 280 330 280 670 500 670 C 720 670 720 330 500 330 Z",
    "M 500 500 L 920 80",
  ],
  document: [
    "M 240 100 L 650 100 L 820 280 L 820 900 L 240 900 Z",
    "M 650 100 L 650 280 L 820 280",
    "M 370 470 L 680 470",
    "M 370 650 L 680 650",
  ],
  spark: ["M 500 80 L 600 400 L 920 500 L 600 600 L 500 920 L 400 600 L 80 500 L 400 400 Z"],
} as const;
function pathXml(value: string) {
  const tokens = value.split(" ");
  let result = "";
  for (let i = 0; i < tokens.length; ) {
    const command = tokens[i++];
    const point = () => `<a:pt x="${tokens[i++]}" y="${tokens[i++]}"/>`;
    if (command === "M") result += `<a:moveTo>${point()}</a:moveTo>`;
    else if (command === "L") result += `<a:lnTo>${point()}</a:lnTo>`;
    else if (command === "C")
      result += `<a:cubicBezTo>${point()}${point()}${point()}</a:cubicBezTo>`;
    else if (command === "Z") result += "<a:close/>";
    else throw new Error("office_invalid");
  }
  return `<a:path w="1000" h="1000" fill="none" stroke="1">${result}</a:path>`;
}
export function icon(input: Extract<PresentationObject, { type: "icon" }>, ctx: ObjectContext) {
  const size = Math.min(ctx.box.width * ctx.width, ctx.box.height * ctx.height);
  const box = rect(
    ctx.box.x + (ctx.box.width - size / ctx.width) / 2,
    ctx.box.y + (ctx.box.height - size / ctx.height) / 2,
    size / ctx.width,
    size / ctx.height,
  );
  const name = `Icon ${input.icon}`;
  const id = ctx.ids.next();
  const links = click(link(ctx.parts, ctx.slide, input.link));
  const geometry = iconGeometry(paths[input.icon].map(pathXml).join(""));
  const stroke = `<a:ln w="25400" cap="rnd">${fill(input.color ?? ctx.theme.colors[0])}<a:prstDash val="solid"/><a:round/></a:ln>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}">${links}</p:cNvPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${transform(box, ctx.width, ctx.height)}${geometry}<a:noFill/>${stroke}</p:spPr></p:sp>`;
}

function iconGeometry(pathsXml: string) {
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="1000" b="1000"/><a:pathLst>${pathsXml}</a:pathLst></a:custGeom>`;
}
