import type { OfficePackage } from "../ooxml/package.ts";
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

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const COMMENTS = "word/comments.xml";

function textOf(xml: XmlPart, node: Element) {
  const parts: string[] = [];
  for (const child of elements(node)) {
    if (child.uri !== W || child.name !== "t") continue;
    const value = leafText(xml, child);
    if (value) parts.push(value);
  }
  return parts.join("");
}

/** Paragraphs and tables directly in the body: the units a user points at in a Word document. */
function body(pkg: OfficePackage, part: string) {
  const xml = pkg.xml(part);
  const node = xml.root.children.find((child) => child.uri === W && child.name === "body");
  if (!node) throw new Error("office_invalid");
  const blocks: Side[] = [];
  let paragraphs = 0;
  let tables = 0;
  for (const child of node.children) {
    if (child.uri !== W) continue;
    const paragraph = child.name === "p";
    if (!paragraph && child.name !== "tbl") continue;
    const raw = xml.source.slice(child.start, child.end);
    blocks.push({
      id: paragraph ? `p:${paragraphs++}` : `t:${tables++}`,
      kind: paragraph ? "paragraph" : "table",
      page: null,
      name: null,
      area: null,
      text: textOf(xml, child),
      signature: normalize(raw),
      raw,
      part,
      span: { start: child.start, end: child.end },
    });
  }
  return { blocks, end: node.closeStart };
}

function comments(pkg: OfficePackage) {
  if (!pkg.has(COMMENTS)) return { blocks: [] as Side[], end: 0 };
  const xml = pkg.xml(COMMENTS);
  const blocks: Side[] = [];
  for (const node of xml.root.children) {
    if (node.uri !== W || node.name !== "comment") continue;
    const key = attribute(node, "id", W) ?? `${blocks.length}`;
    const raw = xml.source.slice(node.start, node.end);
    blocks.push({
      id: `c:${key}`,
      kind: "comment",
      page: null,
      name: null,
      area: null,
      text: textOf(xml, node),
      signature: normalize(raw),
      raw,
      part: COMMENTS,
      span: { start: node.start, end: node.end },
    });
  }
  return { blocks, end: xml.root.closeStart };
}

/** Tracked changes are a mode, not an object: one line reports how many each side still holds. */
function revisions(pkg: OfficePackage, part: string) {
  const xml = pkg.xml(part);
  let inserted = 0;
  let deleted = 0;
  for (const node of elements(xml.root)) {
    if (node.uri !== W) continue;
    if (node.name === "ins") inserted++;
    else if (node.name === "del") deleted++;
  }
  return { inserted, deleted };
}

export function wordChanges(before: OfficePackage, after: OfficePackage): Change[] {
  const beforeMain = before.mainPart();
  const afterMain = after.mainPart();
  const left = body(before, beforeMain);
  const right = body(after, afterMain);
  const changes: Change[] = [];
  const paired = pair(left.blocks, right.blocks);
  // A paragraph the older version had but the newer one lost goes back in front of the next
  // object both sides kept, or at the end of the body.
  const anchors: number[] = new Array(paired.length);
  let anchor = right.end;
  for (let index = paired.length - 1; index >= 0; index--) {
    const { after: next } = paired[index] as { after?: Side };
    if (next) anchor = next.span.start;
    anchors[index] = anchor;
  }
  for (const [index, entry] of paired.entries()) {
    const { before: old, after: next } = entry;
    if (entry.op === "modify" && old && next)
      changes.push(item(next.id, old, next, replaceWith(next, old.raw)));
    else if (entry.op === "add" && next)
      changes.push(item(`${next.id}+`, undefined, next, removeAt(next)));
    else if (entry.op === "remove" && old)
      changes.push(
        item(`${old.id}-`, old, undefined, insertAt(afterMain, anchors[index] as number, old.raw)),
      );
  }
  const leftComments = comments(before);
  const rightComments = comments(after);
  const byId = new Map(leftComments.blocks.map((block) => [block.id, block]));
  const seen = new Set<string>();
  for (const block of rightComments.blocks) {
    const old = byId.get(block.id);
    seen.add(block.id);
    if (!old) changes.push(item(`${block.id}+`, undefined, block, removeAt(block)));
    else if (old.signature !== block.signature)
      changes.push(item(block.id, old, block, replaceWith(block, old.raw)));
  }
  for (const block of leftComments.blocks)
    if (!seen.has(block.id))
      changes.push(
        item(`${block.id}-`, block, undefined, insertAt(COMMENTS, rightComments.end, block.raw)),
      );
  const beforeRevisions = revisions(before, beforeMain);
  const afterRevisions = revisions(after, afterMain);
  if (
    beforeRevisions.inserted !== afterRevisions.inserted ||
    beforeRevisions.deleted !== afterRevisions.deleted
  )
    changes.push({
      item: {
        id: "rev",
        kind: "revision",
        page: null,
        // Counts are data, not copy; the panel labels the line from the interface language.
        name: `+${afterRevisions.inserted} -${afterRevisions.deleted}`,
        area: null,
        before: clip(`+${beforeRevisions.inserted} -${beforeRevisions.deleted}`) || null,
        after: clip(`+${afterRevisions.inserted} -${afterRevisions.deleted}`) || null,
        retractable: false,
      },
    });
  return changes;
}
