import type { OfficeRenderIssue } from "@pibot/protocol-base";
import { descendants, localName, nodeText, type OfficeArchive, type XmlNode } from "./archive.ts";
import { resolvedImages } from "./render-parts.ts";

type Rect = { x: number; y: number; w: number; h: number };
const MAX_OVERLAP_BOXES = 200;
const MIN_TEXT_PT = 12;

function overlaps(a: Rect, b: Rect) {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return false;
  const intersection = width * height;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  // Backgrounds, labels intentionally inside larger objects, and same-box animation overlays
  // are common. Only partial intersections covering a meaningful part of the smaller box count.
  return intersection >= smaller * 0.15 && intersection < smaller * 0.98;
}

export function slideReview(
  page: number,
  part: string,
  xml: Map<string, XmlNode[]>,
  archive: OfficeArchive,
  width: number,
  height: number,
) {
  let visible = 0;
  let outside = 0;
  let collisions = 0;
  let missing = 0;
  let minSize = Infinity;
  let incomplete = !Number.isFinite(width) || !Number.isFinite(height) || !xml.has(part);
  const foreground: Rect[] = [];
  const images = resolvedImages(xml, part, archive);
  function checkImages(node: XmlNode) {
    const blips = descendants([node], "blip");
    for (const blip of blips) {
      const id = Object.entries(blip.attributes).find(([key]) => /:(embed|link)$/.test(key))?.[1];
      if (!id || !images.has(id)) missing++;
    }
    if (localName(node) === "pic" && !blips.length) missing++;
  }
  for (const background of descendants(xml.get(part) ?? [], "bg")) checkImages(background);
  return {
    text(size: number) {
      minSize = Math.min(minSize, size);
    },
    element(node: XmlNode, box: Rect | undefined, out: boolean) {
      const kind = localName(node);
      checkImages(node);
      const content =
        kind === "pic" ||
        kind === "graphicFrame" ||
        descendants([node], "txBody").some((body) => nodeText(body).trim());
      const painted = content || Boolean(box) || kind === "cxnSp";
      if (painted) visible++;
      if (out && kind !== "pic") outside++;
      if (!content) return;
      if (!box || foreground.length >= MAX_OVERLAP_BOXES) {
        incomplete = true;
        return;
      }
      for (const other of foreground) if (overlaps(other, box)) collisions++;
      foreground.push(box);
    },
    issues(): OfficeRenderIssue[] {
      const issues: OfficeRenderIssue[] = [];
      if (!visible) issues.push({ page, code: "empty_slide" });
      if (outside) issues.push({ page, code: "element_outside", value: Math.min(10_000, outside) });
      if (collisions)
        issues.push({ page, code: "element_overlap", value: Math.min(10_000, collisions) });
      if (minSize < MIN_TEXT_PT)
        issues.push({ page, code: "small_text", value: Math.round(minSize * 100) / 100 });
      if (missing) issues.push({ page, code: "missing_picture", value: Math.min(10_000, missing) });
      if (incomplete) issues.push({ page, code: "layout_check_incomplete", severity: "hint" });
      return issues;
    },
  };
}
