import { posix } from "node:path";
import { DOC_REL, STRICT_REL } from "../package.ts";
import { escapeXml } from "../xml.ts";
import { W, type WordDocument, type WordOperation } from "./document.ts";

export function wordImageType(bytes: Uint8Array | undefined): "png" | "jpg" {
  if (!bytes || bytes.length < 24 || bytes.length > 5 * 1024 * 1024)
    throw new Error("office_invalid");
  const b = Buffer.from(bytes);
  let width = 0,
    height = 0;
  if (
    b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
    b.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    width = b.readUInt32BE(16);
    height = b.readUInt32BE(20);
  } else if (b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= b.length) {
      if (b[at++] !== 0xff) throw new Error("office_invalid");
      while (b[at] === 0xff) at++;
      const marker = b[at++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > b.length) break;
      const length = b.readUInt16BE(at);
      if (length < 2 || at + length > b.length) throw new Error("office_invalid");
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (length < 8) throw new Error("office_invalid");
        height = b.readUInt16BE(at + 3);
        width = b.readUInt16BE(at + 5);
        break;
      }
      at += length;
    }
    if (width && height && width * height <= 16_000_000) return "jpg";
  }
  if (!width || !height || width * height > 16_000_000) throw new Error("office_invalid");
  return "png";
}
export function imageWord(d: WordDocument, op: Extract<WordOperation, { op: "word_image" }>) {
  const bytes = d.images[op.image.path],
    type = wordImageType(bytes);
  if (!bytes) throw new Error("office_invalid");
  let n = 1,
    part: string;
  do {
    part = posix.join(posix.dirname(d.main), "media", `pibot${n++}.${type}`);
  } while (d.pkg.has(part));
  d.pkg.addPart(part, bytes, type === "png" ? "image/png" : "image/jpeg");
  const id = d.relationship(part, "image");
  const t = d.paragraph(op.locator),
    strict = d.uri !== W,
    prefix = strict
      ? "http://purl.oclc.org/ooxml/drawingml"
      : "http://schemas.openxmlformats.org/drawingml/2006";
  const a = `${prefix}/main`,
    wp = `${prefix}/wordprocessingDrawing`,
    pic = `${prefix}/picture`,
    r = strict ? STRICT_REL : DOC_REL;
  const docId = d.nextStoryId();
  const cx = op.image.width * 9525,
    cy = op.image.height * 9525,
    alt = escapeXml(op.image.alt);
  const drawing = `<wp:inline xmlns:wp="${wp}" xmlns:a="${a}" xmlns:pic="${pic}" xmlns:r="${r}" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docId}" name="Pi Bot picture ${docId}" descr="${alt}" title="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="${pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Pi Bot picture" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline>`;
  d.insert(t.part, t.xml, t.paragraph, d.tag("r", {}, d.tag("drawing", {}, drawing)));
  if (op.image.caption !== undefined) {
    const next = d.pkg.xml(d.main),
      p = d.paragraph(op.locator).paragraph;
    const at = p.end;
    d.patch(d.main, next, [
      {
        start: at,
        end: at,
        value: d.tag(
          "p",
          {},
          d.tag("pPr", {}, d.tag("pStyle", { val: "Caption" })) + d.run(op.image.caption),
        ),
      },
    ]);
  }
}
