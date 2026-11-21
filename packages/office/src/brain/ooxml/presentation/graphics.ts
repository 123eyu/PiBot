import { escapeXml as esc } from "../xml.ts";
import type { ObjectContext } from "./object-context.ts";
import { type PresentationParts, transform } from "./parts.ts";
import { placeholderXml } from "./text.ts";
export function link(parts: PresentationParts, source: string, url: string | undefined) {
  return url ? parts.relate(source, "hyperlink", url, { external: true }) : undefined;
}
export function click(id: string | undefined) {
  return id ? `<a:hlinkClick r:id="${esc(id)}"/>` : "";
}
export function frame(ctx: ObjectContext, data: string) {
  const id = ctx.ids.next();
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Object ${id}"/><p:cNvGraphicFramePr/><p:nvPr>${placeholderXml(ctx.placeholder)}</p:nvPr></p:nvGraphicFramePr>${transform(ctx.box, ctx.width, ctx.height, "p")}<a:graphic>${data}</a:graphic></p:graphicFrame>`;
}
