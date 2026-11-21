import { DOC_REL, type OfficePackage, STRICT_REL } from "../ooxml/package.ts";
import { attribute, type Element, elements, leafText, type XmlPart } from "../ooxml/xml.ts";
import {
  type Change,
  clip,
  insertAt,
  item,
  normalize,
  pair,
  removeAt,
  replaceWith,
  type Side,
} from "./blocks.ts";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PRESENTATION = "ppt/presentation.xml";
const SHAPES = new Set(["sp", "pic", "graphicFrame", "grpSp", "cxnSp"]);

function textOf(xml: XmlPart, node: Element) {
  const parts: string[] = [];
  for (const child of elements(node)) {
    if (child.uri !== A || child.name !== "t") continue;
    const value = leafText(xml, child);
    if (value) parts.push(value);
  }
  return parts.join("");
}

/** Slide parts in presentation order: sldIdLst keeps the order, the relationships the targets. */
function slides(pkg: OfficePackage) {
  const targets = new Map(
    pkg
      .relationships(PRESENTATION)
      .filter(({ target }) => target !== undefined)
      .map(({ id, target }) => [id, target as string]),
  );
  const xml = pkg.xml(PRESENTATION);
  const list = xml.root.children.find((child) => child.uri === P && child.name === "sldIdLst");
  const parts: string[] = [];
  for (const node of list?.children ?? []) {
    if (node.uri !== P || node.name !== "sldId") continue;
    const id =
      attribute(node, "id", DOC_REL) ?? attribute(node, "id", STRICT_REL) ?? node.attrs.get("r:id");
    const part = id ? targets.get(id) : undefined;
    if (part) parts.push(part);
  }
  return parts;
}

function shapes(pkg: OfficePackage, part: string, page: number) {
  const xml = pkg.xml(part);
  const tree = Array.from(elements(xml.root)).find(
    (node) => node.uri === P && node.name === "spTree",
  );
  if (!tree) return { blocks: [] as Side[], end: 0 };
  const blocks: Side[] = [];
  let index = 0;
  for (const child of tree.children) {
    if (child.uri !== P || !SHAPES.has(child.name)) continue;
    const identity = [...elements(child)].find((node) => node.name === "cNvPr");
    const raw = xml.source.slice(child.start, child.end);
    const text = textOf(xml, child);
    blocks.push({
      id: `s${page}:${identity?.attrs.get("id") ?? index}`,
      kind: child.name === "pic" ? "shape" : "shape",
      page,
      name: identity?.attrs.get("name")?.slice(0, 200) || clip(text) || null,
      area: null,
      text,
      signature: normalize(raw),
      raw,
      part,
      span: { start: child.start, end: child.end },
    });
    index++;
  }
  return { blocks, end: tree.closeStart };
}

function slideTitle(pkg: OfficePackage, part: string) {
  return clip(
    shapes(pkg, part, 0)
      .blocks.map((block) => block.text)
      .join(" "),
  );
}

export function presentationChanges(before: OfficePackage, after: OfficePackage): Change[] {
  const changes: Change[] = [];
  const left = slides(before);
  const right = slides(after);
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  right.forEach((part, index) => {
    const page = index + 1;
    if (!leftSet.has(part)) {
      // A slide is a package part with its own relationships; putting it back or dropping it would
      // rewrite the presentation, content types and rels, so only the file-level revert remains.
      changes.push({
        item: {
          id: `sl:${page}`,
          kind: "slide",
          page,
          name: slideTitle(after, part) || null,
          area: null,
          before: null,
          after: slideTitle(after, part) || null,
          retractable: false,
        },
      });
      return;
    }
    const pairShapes = pair(shapes(before, part, page).blocks, shapes(after, part, page).blocks);
    const right_ = shapes(after, part, page);
    const anchors: number[] = new Array(pairShapes.length);
    let anchor = right_.end;
    for (let index2 = pairShapes.length - 1; index2 >= 0; index2--) {
      const next = pairShapes[index2]?.after;
      if (next) anchor = next.span.start;
      anchors[index2] = anchor;
    }
    for (const [index2, entry] of pairShapes.entries()) {
      const { before: old, after: next } = entry;
      if (entry.op === "modify" && old && next)
        changes.push(item(next.id, old, next, replaceWith(next, old.raw)));
      else if (entry.op === "add" && next)
        changes.push(item(`${next.id}+`, undefined, next, removeAt(next)));
      else if (entry.op === "remove" && old)
        changes.push(
          item(`${old.id}-`, old, undefined, insertAt(part, anchors[index2] as number, old.raw)),
        );
    }
  });
  for (const [index, part] of left.entries())
    if (!rightSet.has(part)) {
      const page = index + 1;
      changes.push({
        item: {
          id: `sl:${page}-`,
          kind: "slide",
          page,
          name: slideTitle(before, part) || null,
          area: null,
          before: slideTitle(before, part) || null,
          after: null,
          retractable: false,
        },
      });
    }
  return changes;
}
