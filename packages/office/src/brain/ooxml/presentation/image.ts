import type { PresentationObject } from "@pibot/protocol-base/office-content";
import { escapeXml as esc } from "../xml.ts";
import { click, link } from "./graphics.ts";
import { presentationImageInfo } from "./image-info.ts";
import type { ObjectContext } from "./object-context.ts";
import { transform } from "./parts.ts";
import { placeholderXml } from "./text.ts";
import { rect } from "./themes.ts";
export function image(input: Extract<PresentationObject, { type: "image" }>, ctx: ObjectContext) {
  const data = ctx.images[input.path];
  const { width, height, extension, contentType } = presentationImageInfo(data);
  if (!data) throw new Error("office_invalid");
  const part = ctx.parts.image(input.path, extension, contentType, data);
  const id = ctx.parts.relate(ctx.slide, "image", part);
  const hyperlink = link(ctx.parts, ctx.slide, input.link);
  let box = ctx.box;
  const ratio = width / height,
    area = (box.width * ctx.width) / (box.height * ctx.height);
  let crop = "";
  if ((input.fit ?? "contain") === "contain") {
    box =
      ratio > area
        ? rect(
            box.x,
            box.y + (box.height - (box.width * ctx.width) / ratio / ctx.height) / 2,
            box.width,
            (box.width * ctx.width) / ratio / ctx.height,
          )
        : rect(
            box.x + (box.width - (box.height * ctx.height * ratio) / ctx.width) / 2,
            box.y,
            (box.height * ctx.height * ratio) / ctx.width,
            box.height,
          );
  } else {
    const cut = Math.round((1 - (ratio > area ? area / ratio : ratio / area)) * 50_000);
    crop =
      ratio > area ? `<a:srcRect l="${cut}" r="${cut}"/>` : `<a:srcRect t="${cut}" b="${cut}"/>`;
  }
  const properties = pictureProperties(input, ctx, hyperlink);
  const blip = `<p:blipFill><a:blip r:embed="${id}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>`;
  const geometry = `<p:spPr>${transform(box, ctx.width, ctx.height)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`;
  return `<p:pic>${properties}${blip}${geometry}</p:pic>`;
}

function pictureProperties(
  input: Extract<PresentationObject, { type: "image" }>,
  ctx: ObjectContext,
  hyperlink: string | undefined,
) {
  const id = ctx.ids.next();
  return [
    `<p:nvPicPr><p:cNvPr id="${id}" name="Image ${id}" descr="${esc(input.alt ?? "")}">${click(hyperlink)}</p:cNvPr>`,
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>',
    `<p:nvPr>${placeholderXml(ctx.placeholder)}</p:nvPr></p:nvPicPr>`,
  ].join("");
}
