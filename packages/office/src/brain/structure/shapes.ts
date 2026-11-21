import type { OfficeStructureItem } from "@pibot/protocol-base/office-content";
import type { Element, XmlPart } from "../ooxml/xml.ts";
import type { StructureContext } from "./page.ts";
import { smartartItems } from "./smartart.ts";
import { attr, belongs, child, DRAW, nodes, PRESENTATION } from "./xml.ts";
export const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
export function* shapeChildren(tree: Element): Generator<Element> {
  for (const node of tree.children) {
    if (node.uri === MC && node.name === "AlternateContent") {
      yield node;
      continue;
    }
    if (
      belongs(node, PRESENTATION) &&
      ["sp", "pic", "graphicFrame", "cxnSp", "grpSp", "contentPart"].includes(node.name)
    )
      yield node;
  }
}
export function* shapes(
  ctx: StructureContext,
  xml: XmlPart,
  tree: Element,
  slide: number,
  part: string,
  parentId?: string,
): Generator<OfficeStructureItem> {
  let z = 0;
  for (const node of shapeChildren(tree)) {
    if (node.uri === MC) {
      yield { kind: "shape", slide, type: "alternate_content", position: {}, z: z++, parentId };
      continue;
    }
    const nonVisual = node.children.find(
      (item) => item.name.startsWith("nv") && belongs(item, PRESENTATION),
    );
    const props = nonVisual && child(nonVisual, "cNvPr", PRESENTATION);
    const nvProps = nonVisual && child(nonVisual, "nvPr", PRESENTATION);
    const ph = nvProps && child(nvProps, "ph", PRESENTATION);
    const id = ctx.budget.clip(attr(props, "id"));
    const shapeProps = child(node, node.name === "grpSp" ? "grpSpPr" : "spPr", PRESENTATION);
    const xfrm =
      node.name === "graphicFrame"
        ? child(node, "xfrm", PRESENTATION)
        : shapeProps && child(shapeProps, "xfrm", DRAW);
    const off = xfrm && child(xfrm, "off", DRAW);
    const ext = xfrm && child(xfrm, "ext", DRAW);
    const type = node.name === "graphicFrame" ? graphicType(node) : node.name;
    yield {
      kind: "shape",
      slide,
      id,
      type,
      placeholder: ph
        ? {
            type: ctx.budget.clip(attr(ph, "type")) ?? "obj",
            index: ctx.budget.clip(attr(ph, "idx")),
          }
        : undefined,
      text: ctx.budget.text(xml, node, DRAW, " "),
      position: {
        x: coordinate(off, "x"),
        y: coordinate(off, "y"),
        width: coordinate(ext, "cx"),
        height: coordinate(ext, "cy"),
      },
      z: z++,
      parentId,
    };
    if (node.name === "grpSp") yield* shapes(ctx, xml, node, slide, part, id);
    if (type === "smartart") yield* smartartItems(ctx, node, part, slide, id);
  }
}
function coordinate(node: Element | undefined, name: string) {
  const value = attr(node, name);
  if (value === undefined) return;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function graphicType(node: Element) {
  const data = [...nodes(node, "graphicData", DRAW)][0];
  const uri = attr(data, "uri") ?? "";
  if (uri.endsWith("/chart")) return "chart";
  if (uri.endsWith("/table")) return "table";
  if (uri.endsWith("/diagram")) return "smartart";
  return "graphicFrame";
}
