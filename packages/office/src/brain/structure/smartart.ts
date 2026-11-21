import type { OfficeStructureItem } from "@pibot/protocol-base/office-content";
import type { Element } from "../ooxml/xml.ts";
import type { StructureContext } from "./page.ts";
import { attr, DRAW, relations, target } from "./xml.ts";

const DIAGRAM = "http://schemas.openxmlformats.org/drawingml/2006/diagram";

/**
 * Only the data model is read: layout and quick-style parts describe rendering, while the
 * model carries the text and parent/child links a caller can reason about.
 */
export function* smartartItems(
  ctx: StructureContext,
  frame: Element,
  part: string,
  slide: number,
  id: string | undefined,
): Generator<OfficeStructureItem> {
  const relIds = frame.children.find((node) => node.name === "relIds");
  const dataPart = relIds && target(relations(ctx.pkg, part), relIds, "diagramData");
  const data = dataPart && ctx.pkg.optional(dataPart, part);
  if (!data) return;
  const nodes: { id?: string; text: string }[] = [];
  const links: [string, string][] = [];
  for (const node of data.root.children) {
    if (node.uri !== DIAGRAM) continue;
    if (node.name === "pt" && nodes.length < 20) {
      const text = ctx.budget.text(data, node, DRAW, " ");
      // Transition points alias their neighbours; only text-bearing items are reporting units.
      if (text) nodes.push({ id: ctx.budget.clip(attr(node, "modelId"), 64), text });
      continue;
    }
    if (node.name === "cxnLst")
      for (const link of node.children) {
        if (link.name !== "cxn" || links.length >= 40) continue;
        const from = ctx.budget.clip(attr(link, "srcId"), 64);
        const to = ctx.budget.clip(attr(link, "destId"), 64);
        if (from && to) links.push([from, to]);
      }
  }
  yield { kind: "smartart", slide, id, nodes, links };
}
