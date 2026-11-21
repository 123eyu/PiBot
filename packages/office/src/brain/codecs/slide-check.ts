import type { OfficeRenderIssue } from "@pibot/protocol-base";
import { descendants, localName, nodeText, type OfficeArchive, type XmlNode } from "./archive.ts";
import { child, relatedPart } from "./render-parts.ts";
import { slideReview } from "./slide-review.ts";

const EMU_PER_POINT = 12_700;
/** PowerPoint's "shrink text on overflow" bottoms out at 25% of the font size. */
const MIN_FONT_SCALE = 0.25;
/** Below this the slide reads as a wall of tiny text even though it technically fits. */
const SHRUNK_HINT_SCALE = 0.6;
type Rect = { x: number; y: number; w: number; h: number };
type Transform = { x: number; y: number; sx: number; sy: number };
type Style = { size: number; face?: string; bold: boolean; color?: string };
const namedColors: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  gray: "808080",
};
const number = (raw: string | undefined, fallback: number) => {
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
function box(xfrm: XmlNode | undefined): Rect | undefined {
  const off = child(xfrm, "off")?.attributes;
  const ext = child(xfrm, "ext")?.attributes;
  if (!off || !ext) return;
  const result = { x: Number(off.x), y: Number(off.y), w: Number(ext.cx), h: Number(ext.cy) };
  if (Object.values(result).every(Number.isFinite) && result.w > 0 && result.h > 0) return result;
}
function groupTransform(xfrm: XmlNode | undefined, outer: Transform): Transform | undefined {
  const rect = box(xfrm);
  const offset = child(xfrm, "chOff")?.attributes;
  const extent = child(xfrm, "chExt")?.attributes;
  if (!rect || !offset || !extent || Number(xfrm?.attributes.rot ?? 0)) return;
  const sx = (outer.sx * rect.w) / Number(extent.cx);
  const sy = (outer.sy * rect.h) / Number(extent.cy);
  const x = outer.x + outer.sx * rect.x - sx * Number(offset.x);
  const y = outer.y + outer.sy * rect.y - sy * Number(offset.y);
  if ([x, y, sx, sy].every(Number.isFinite) && sx > 0 && sy > 0) return { x, y, sx, sy };
}
function color(fill: XmlNode | undefined, palette: Map<string, string>) {
  const color = fill?.children[0];
  if (!color || color.children.length) return;
  const kind = localName(color);
  const val = color.attributes.val ?? "";
  const rgb =
    kind === "srgbClr"
      ? val
      : kind === "sysClr"
        ? color.attributes.lastClr
        : kind === "schemeClr"
          ? palette.get(val)
          : kind === "prstClr"
            ? namedColors[val]
            : undefined;
  return rgb && /^[a-f0-9]{6}$/i.test(rgb) ? rgb : undefined;
}
function luminance(hex: string) {
  const rgb = [0, 2, 4].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (rgb[0] ?? 0) + 0.7152 * (rgb[1] ?? 0) + 0.0722 * (rgb[2] ?? 0);
}
function ratio(foreground: string, background: string) {
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function styleOf(
  nodes: (XmlNode | undefined)[],
  palette: Map<string, string>,
  size: number,
): Style {
  const attribute = (key: string) =>
    nodes.find((node) => node?.attributes[key] !== undefined)?.attributes[key];
  const firstFont = nodes.map((node) => child(node, "latin")?.attributes.typeface).find(Boolean);
  const fill = nodes.map((node) => child(node, "solidFill")).find(Boolean);
  return {
    size: Math.max(1, number(attribute("sz"), size * 100) / 100),
    bold: ["1", "true"].includes(attribute("b") ?? ""),
    face: firstFont,
    color: color(fill, palette),
  };
}
function widthOf(text: string, size: number) {
  let units = 0;
  for (const char of text)
    units += /\p{Mark}/u.test(char)
      ? 0
      : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(
            char,
          )
        ? 1
        : /\s/u.test(char)
          ? 0.3
          : 0.55;
  return units * size;
}

function slideStyle(part: string, xml: Map<string, XmlNode[]>) {
  const layout = relatedPart(xml, part, "slideLayout");
  const master = layout && relatedPart(xml, layout, "slideMaster");
  const theme = master && relatedPart(xml, master, "theme");
  const palette = new Map<string, string>();
  const colors = theme ? descendants(xml.get(theme) ?? [], "clrScheme")[0] : undefined;
  for (const entry of colors?.children ?? []) {
    const rgb = color(entry, palette);
    if (rgb) palette.set(localName(entry), rgb);
  }
  const colorMap = master ? descendants(xml.get(master) ?? [], "clrMap")[0] : undefined;
  for (const [alias, key] of Object.entries(colorMap?.attributes ?? {})) {
    const rgb = palette.get(key);
    if (rgb) palette.set(alias, rgb);
  }
  const background = [part, layout, master].flatMap((name) =>
    name ? descendants(xml.get(name) ?? [], "bg") : [],
  )[0];
  const bg = background
    ? color(child(child(background, "bgPr"), "solidFill"), palette)
    : (palette.get("bg1") ?? "FFFFFF");
  return { palette, bg };
}

function textMetrics(
  shape: XmlNode,
  rect: Rect | undefined,
  palette: Map<string, string>,
  bg: string | undefined,
  fonts: Set<string>,
) {
  const body = child(shape, "txBody");
  const settings = child(body, "bodyPr");
  const attrs = settings?.attributes ?? {};
  const width = rect
    ? (rect.w - number(attrs.lIns, 91_440) - number(attrs.rIns, 91_440)) / EMU_PER_POINT
    : Infinity;
  const height = rect
    ? (rect.h - number(attrs.tIns, 45_720) - number(attrs.bIns, 45_720)) / EMU_PER_POINT
    : Infinity;
  const shapeProperties = child(shape, "spPr");
  const shapeFill = child(shapeProperties, "solidFill");
  const background = shapeFill
    ? color(shapeFill, palette)
    : ["gradFill", "blipFill", "pattFill", "grpFill"].some((fill) => child(shapeProperties, fill))
      ? undefined
      : bg;
  const type = descendants([shape], "ph")[0]?.attributes.type;
  const title = type === "title" || type === "ctrTitle" || type === "subTitle";
  // WCAG counts page numbers, footers and dates as incidental text; they only get a hint here.
  const incidental = ["sldNum", "ftr", "dt", "hdr"].includes(type ?? "");
  const listStyle = child(body, "lstStyle");
  let minSize = Infinity;
  let points = 0,
    totalHeight = 0,
    lines = 0,
    lowContrast = Infinity,
    hintContrast = Infinity,
    tooWide = false;
  for (const paragraph of body?.children.filter((item) => localName(item) === "p") ?? []) {
    const text = nodeText(paragraph).trim();
    if (!text) continue;
    const props = child(paragraph, "pPr");
    const level = child(listStyle, `lvl${number(props?.attributes.lvl, 0) + 1}pPr`);
    const bullet = [props, level].find((node) =>
      ["buNone", "buChar", "buAutoNum", "buBlip"].some((name) => child(node, name)),
    );
    if (
      !title &&
      !child(bullet, "buNone") &&
      (bullet || type === "body" || type === "obj" || /^[•·▪◦‣]\s/u.test(text))
    )
      points++;
    let line = 0,
      lineSize = 0,
      lineTotal = 0;
    for (const run of paragraph.children) {
      if (localName(run) === "br") {
        const factor = lineCount(line, width, attrs.wrap === "none");
        lineTotal += lineSize * 1.15 * factor;
        lines += factor;
        tooWide ||= attrs.wrap === "none" && line > width;
        line = 0;
        lineSize = 0;
        continue;
      }
      const textNode = child(run, "t");
      const text = textNode ? nodeText(textNode) : "";
      if (!text) continue;
      const style = styleOf(
        [child(run, "rPr"), child(props, "defRPr"), child(level, "defRPr")],
        palette,
        title ? 32 : 18,
      );
      if (!incidental) minSize = Math.min(minSize, style.size);
      if (style.face && !style.face.startsWith("+")) fonts.add(style.face.toLowerCase());
      lineSize = Math.max(lineSize, style.size);
      line += widthOf(text, style.size);
      if (background && style.color) {
        const contrast = ratio(style.color, background);
        if (contrast < (style.size >= 18 || (style.bold && style.size >= 14) ? 3 : 4.5)) {
          if (incidental) hintContrast = Math.min(hintContrast, contrast);
          else lowContrast = Math.min(lowContrast, contrast);
        }
      }
    }
    tooWide ||= attrs.wrap === "none" && line > width;
    const factor = lineCount(line, width, attrs.wrap === "none");
    lines += factor;
    totalHeight += lineTotal + lineSize * 1.15 * factor;
  }
  const space = Math.max(0, height);
  const average = lines ? totalHeight / lines : 0;
  const autofit = Boolean(child(settings, "normAutofit"));
  const scale = totalHeight > space && totalHeight > 0 ? space / totalHeight : 1;
  let overflowLines = tooWide ? 1 : 0;
  let shrunkScale = 1;
  if (autofit) {
    // Shrinking is only estimated: a slide whose text still needs less than the minimum
    // scale genuinely overflows, and one below 60% reads as a wall of tiny text.
    if (totalHeight > space && scale < MIN_FONT_SCALE)
      overflowLines = Math.max(
        overflowLines,
        Math.ceil((totalHeight * MIN_FONT_SCALE - space) / Math.max(1, average * MIN_FONT_SCALE)),
      );
    else if (scale < SHRUNK_HINT_SCALE) shrunkScale = scale;
  } else if (!overflowLines && totalHeight > space * 1.05)
    overflowLines = Math.max(1, Math.ceil((totalHeight - space) / Math.max(1, average)));
  return {
    points,
    lowContrast,
    hintContrast,
    overflowLines,
    shrunkScale,
    minSize: minSize * (autofit ? Math.max(MIN_FONT_SCALE, scale) : 1),
  };
}

/** How many rendered lines a run of text takes in a fixed-width box. */
function lineCount(width: number, available: number, noWrap: boolean) {
  return noWrap || available <= 0 ? 1 : Math.max(1, Math.ceil(width / available));
}

function outside(
  rect: Rect,
  xfrm: XmlNode | undefined,
  transform: Transform,
  width: number,
  height: number,
) {
  const angle = (number(xfrm?.attributes.rot, 0) * Math.PI) / 10_800_000;
  const w =
    (Math.abs(Math.cos(angle)) * rect.w + Math.abs(Math.sin(angle)) * rect.h) * transform.sx;
  const h =
    (Math.abs(Math.sin(angle)) * rect.w + Math.abs(Math.cos(angle)) * rect.h) * transform.sy;
  const x = transform.x + (rect.x + rect.w / 2) * transform.sx;
  const y = transform.y + (rect.y + rect.h / 2) * transform.sy;
  const tolerance = EMU_PER_POINT;
  return (
    x - w / 2 < -tolerance ||
    y - h / 2 < -tolerance ||
    x + w / 2 > width + tolerance ||
    y + h / 2 > height + tolerance
  );
}

export function checkSlide(
  page: number,
  part: string,
  size: Record<string, string> | undefined,
  xml: Map<string, XmlNode[]>,
  archive?: OfficeArchive,
): OfficeRenderIssue[] {
  const tree = descendants(xml.get(part) ?? [], "spTree")[0];
  const { palette, bg } = slideStyle(part, xml);
  const fonts = new Set<string>();
  let points = 0,
    overflowLines = 0,
    shrunkScale = 1,
    pictures = 0,
    contrast = Infinity,
    hintContrast = Infinity;
  const width = number(size?.cx, Infinity),
    height = number(size?.cy, Infinity);
  const review = archive ? slideReview(page, part, xml, archive, width, height) : undefined;
  function visit(node: XmlNode, transform: Transform | undefined) {
    const kind = localName(node);
    const xfrm = child(child(node, "spPr"), "xfrm") ?? child(node, "xfrm");
    const rect = box(xfrm);
    if (kind === "sp") {
      const metrics = textMetrics(node, rect, palette, bg, fonts);
      review?.text(metrics.minSize);
      points += metrics.points;
      overflowLines += metrics.overflowLines;
      shrunkScale = Math.min(shrunkScale, metrics.shrunkScale);
      contrast = Math.min(contrast, metrics.lowContrast);
      hintContrast = Math.min(hintContrast, metrics.hintContrast);
    } else if (kind === "pic" && rect && transform && outside(rect, xfrm, transform, width, height))
      pictures++;
    else if (kind === "spTree" || kind === "grpSp") {
      const next =
        kind === "grpSp" && transform
          ? groupTransform(child(child(node, "grpSpPr"), "xfrm"), transform)
          : transform;
      for (const item of node.children) visit(item, next);
    }
    if (review && ["sp", "pic", "graphicFrame", "cxnSp"].includes(kind)) {
      const angle = number(xfrm?.attributes.rot, 0);
      const measured =
        rect && transform && !angle
          ? {
              x: transform.x + rect.x * transform.sx,
              y: transform.y + rect.y * transform.sy,
              w: rect.w * transform.sx,
              h: rect.h * transform.sy,
            }
          : undefined;
      review.element(
        node,
        measured,
        Boolean(rect && transform && outside(rect, xfrm, transform, width, height)),
      );
    }
  }
  if (tree) visit(tree, { x: 0, y: 0, sx: 1, sy: 1 });
  const issues: OfficeRenderIssue[] = [];
  if (overflowLines)
    issues.push({ page, code: "text_overflow", value: Math.min(10_000, overflowLines) });
  if (Number.isFinite(contrast))
    issues.push({ page, code: "low_contrast", value: Math.round(contrast * 100) / 100 });
  if (shrunkScale < 1)
    issues.push({
      page,
      code: "text_shrunk",
      value: Math.round(shrunkScale * 100),
      severity: "hint",
    });
  if (Number.isFinite(hintContrast))
    issues.push({
      page,
      code: "low_contrast",
      value: Math.round(hintContrast * 100) / 100,
      severity: "hint",
    });
  if (fonts.size > 3)
    issues.push({ page, code: "too_many_fonts", value: Math.min(10_000, fonts.size) });
  if (points > 6) issues.push({ page, code: "too_many_points", value: Math.min(10_000, points) });
  if (pictures) issues.push({ page, code: "picture_outside", value: Math.min(10_000, pictures) });
  return [...issues, ...(review?.issues() ?? [])];
}
