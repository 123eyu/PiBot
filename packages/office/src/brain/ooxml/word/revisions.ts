import { one } from "../locate.ts";
import { type Element, elements } from "../xml.ts";
import type { WordDocument, WordOperation } from "./document.ts";
import { restoreProperties, unwrapRevision } from "./revision-xml.ts";

export function revisions(d: WordDocument, op: Extract<WordOperation, { op: "word_revision" }>) {
  const supported = [
    "ins",
    "del",
    "rPrChange",
    "pPrChange",
    "tblPrChange",
    "trPrChange",
    "tcPrChange",
    "sectPrChange",
  ];
  // Revision IDs can repeat in different stories; refuse ambiguous IDs rather than silently editing one.
  for (const id of op.ids) {
    const { part, node, parent, xml } = revisionTarget(d, id, supported);
    if (["trPr", "rPr"].includes(parent.name) && ["ins", "del"].includes(node.name))
      throw new Error("office_unsupported");
    if (Array.from(elements(node)).some((n) => n.uri === d.uri && n.name === "delInstrText"))
      throw new Error("office_unsupported");
    if (
      !supported.includes(node.name) ||
      Array.from(elements(node)).some((n) => n !== node && supported.includes(n.name))
    )
      throw new Error("office_unsupported");
    if (node.name.endsWith("PrChange")) {
      if (op.action === "accept") d.replace(part, xml, node, "");
      else restoreProperties(d, part, xml, parent, node);
      continue;
    }
    if (
      (node.name === "ins" && op.action === "reject") ||
      (node.name === "del" && op.action === "accept")
    )
      d.replace(part, xml, node, "");
    else {
      if (parent.name === "trPr" || parent.name === "rPr" || !node.children.length)
        throw new Error("office_unsupported");
      d.replace(part, xml, node, unwrapRevision(d, xml, node));
    }
  }
}

function revisionTarget(d: WordDocument, id: string, supported: string[]) {
  const matches: {
    part: string;
    node: Element;
    parent: Element;
    xml: ReturnType<WordDocument["pkg"]["xml"]>;
  }[] = [];
  const parts = d.storyParts();
  for (const part of parts) {
    const xml = d.pkg.xml(part);
    for (const parent of elements(xml.root))
      for (const node of parent.children)
        if (
          node.uri === d.uri &&
          d.attr(node, "id") === id &&
          (supported.includes(node.name) || ["moveFrom", "moveTo"].includes(node.name))
        )
          matches.push({ part, node, parent, xml });
  }
  return one(matches);
}
