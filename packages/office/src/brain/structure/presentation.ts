import type { OfficeStructureItem } from "@pibot/protocol-base/office-content";
import type { Element, XmlPart } from "../ooxml/xml.ts";
import type { StructureContext } from "./page.ts";
import { shapes } from "./shapes.ts";
import {
  attr,
  belongs,
  byKind,
  child,
  DRAW,
  nodes,
  PRESENTATION,
  relations,
  target,
} from "./xml.ts";

export function* presentationStructure(ctx: StructureContext): Generator<OfficeStructureItem> {
  const { pkg, query } = ctx;
  const main = pkg.mainPart();
  const xml = pkg.xml(main);
  if (xml.root.name !== "presentation" || !belongs(xml.root, PRESENTATION))
    throw new Error("office_invalid_document");
  const rels = relations(pkg, main);
  const slides =
    child(xml.root, "sldIdLst", PRESENTATION)?.children.filter(
      (node) => node.name === "sldId" && belongs(node, PRESENTATION),
    ) ?? [];
  ctx.summary.slides = slides.length;
  if (!query.collection || ["master", "layout"].includes(query.collection))
    yield* masters(ctx, xml, main);
  if (query.collection && ["master", "layout"].includes(query.collection)) return;
  for (const [index, id] of slides.entries()) {
    const slide = index + 1;
    if (query.slide !== undefined && query.slide !== slide) continue;
    const part = target(rels, id, "slide");
    const source = pkg.optional(part, main);
    if (part && source) yield* slideItems(ctx, source, part, slide);
  }
}
function* masters(
  ctx: StructureContext,
  xml: XmlPart,
  main: string,
): Generator<OfficeStructureItem> {
  const rels = relations(ctx.pkg, main);
  const ids = child(xml.root, "sldMasterIdLst", PRESENTATION);
  const seen = new Set<string>();
  for (const id of ids?.children ?? []) {
    const part = target(rels, id, "slideMaster");
    const master = ctx.pkg.optional(part, main);
    if (!part || !master) continue;
    yield {
      kind: "master",
      part,
      name: ctx.budget.clip(attr(child(master.root, "cSld", PRESENTATION), "name")),
    };
    if (ctx.query.collection === "master") continue;
    const masterRels = relations(ctx.pkg, part);
    for (const layoutId of child(master.root, "sldLayoutIdLst", PRESENTATION)?.children ?? []) {
      const layoutPart = target(masterRels, layoutId, "slideLayout");
      if (layoutPart && seen.has(layoutPart)) continue;
      const layout = ctx.pkg.optional(layoutPart, part);
      if (!layoutPart || !layout) continue;
      seen.add(layoutPart);
      yield {
        kind: "layout",
        part: layoutPart,
        masterPart: part,
        name: ctx.budget.clip(attr(child(layout.root, "cSld", PRESENTATION), "name")),
        type: ctx.budget.clip(attr(layout.root, "type")),
      };
    }
  }
}
function* slideItems(
  ctx: StructureContext,
  xml: XmlPart,
  part: string,
  slide: number,
): Generator<OfficeStructureItem> {
  const rels = relations(ctx.pkg, part);
  const common = child(xml.root, "cSld", PRESENTATION);
  const tree = common && child(common, "spTree", PRESENTATION);
  yield {
    kind: "slide",
    slide,
    part,
    layoutPart: byKind(rels, "slideLayout")[0],
    title: tree && slideTitle(ctx, xml, tree),
  };
  if (tree && (!ctx.query.collection || ctx.query.collection === "shape"))
    yield* shapes(ctx, xml, tree, slide, part);
  if (ctx.query.collection && ctx.query.collection !== "notes") return;
  for (const notesPart of byKind(rels, "notesSlide")) {
    const notes = ctx.pkg.optional(notesPart, part);
    if (notes) yield { kind: "notes", slide, text: noteText(ctx, notes) };
  }
}
function slideTitle(ctx: StructureContext, xml: XmlPart, tree: Element) {
  for (const shape of nodes(tree, "sp", PRESENTATION)) {
    const ph = [...nodes(shape, "ph", PRESENTATION)][0];
    if (["title", "ctrTitle"].includes(attr(ph, "type") ?? ""))
      return ctx.budget.text(xml, shape, DRAW, " ");
  }
  return undefined;
}
function noteText(ctx: StructureContext, xml: XmlPart) {
  const body: string[] = [];
  let length = 0;
  for (const shape of nodes(xml.root, "sp", PRESENTATION)) {
    const ph = [...nodes(shape, "ph", PRESENTATION)][0];
    if (["sldNum", "hdr", "ftr", "dt"].includes(attr(ph, "type") ?? "")) continue;
    const content = ctx.budget.text(xml, shape, DRAW, " ");
    if (content) {
      body.push(content);
      length += content.length + 1;
    }
    if (length > 2_000) {
      ctx.budget.truncated = true;
      break;
    }
  }
  return ctx.budget.clip(body.join("\n")) ?? "";
}
