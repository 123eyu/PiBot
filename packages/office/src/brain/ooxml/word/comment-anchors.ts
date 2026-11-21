import { one } from "../locate.ts";
import { attribute, type Element } from "../xml.ts";
import { paragraphId } from "./comment-parts.ts";
import { W14, type WordDocument, type WordLocator } from "./document.ts";

export function parentParagraph(d: WordDocument, part: string, existing?: Element) {
  let xml = d.pkg.xml(part);
  let parent: string | undefined;
  if (existing) {
    const last = d.all({ source: xml.source, root: existing }, "p").at(-1);
    if (!last) throw new Error("office_unsupported");
    parent = attribute(last, "paraId", W14);
    if (!parent) {
      parent = paragraphId(d);
      const raw = d.raw(xml, last),
        at = raw.indexOf(">");
      const insert = raw[at - 1] === "/" ? at - 1 : at;
      d.replace(
        part,
        xml,
        last,
        `${raw.slice(0, insert)} xmlns:w14="${W14}" w14:paraId="${parent}"${raw.slice(insert)}`,
      );
      xml = d.pkg.xml(part);
    }
  }
  return parent;
}

export function anchorReply(d: WordDocument, parent: string, id: number) {
  const anchors = d.storyParts().flatMap((part) => {
    const xml = d.pkg.xml(part);
    return d
      .all(xml, "commentRangeStart")
      .filter((n) => d.attr(n, "id") === parent)
      .map((start) => ({ part, xml, start }));
  });
  const { part, xml, start } = one(anchors);
  const end = one(d.all(xml, "commentRangeEnd").filter((n) => d.attr(n, "id") === parent));
  const reference = one(d.all(xml, "commentReference").filter((n) => d.attr(n, "id") === parent));
  const run = one(
    d.all(xml, "r").filter((n) => reference.start >= n.openEnd && reference.end <= n.closeStart),
  );
  if (end.start < start.end) throw new Error("office_unsupported");
  const inserts = new Map<number, string>();
  for (const [at, value] of [
    [start.end, d.tag("commentRangeStart", { id })],
    [end.start, d.tag("commentRangeEnd", { id })],
    [run.end, commentReference(d, id)],
  ] as const)
    inserts.set(at, (inserts.get(at) ?? "") + value);
  d.patch(
    part,
    xml,
    Array.from(inserts, ([start, value]) => ({ start, end: start, value })),
  );
}
function commentReference(d: WordDocument, id: number) {
  return d.tag(
    "r",
    {},
    d.tag("rPr", {}, d.tag("rStyle", { val: "CommentReference" })) +
      d.tag("commentReference", { id }),
  );
}
export function anchorComment(d: WordDocument, locator: WordLocator, id: number) {
  const t = d.paragraph(locator),
    ppr = d.child(t.paragraph, "pPr"),
    at = ppr?.end ?? t.paragraph.openEnd;
  const start = d.tag("commentRangeStart", { id }),
    end = d.tag("commentRangeEnd", { id }) + commentReference(d, id);
  if (t.paragraph.closeStart === t.paragraph.end) d.insert(t.part, t.xml, t.paragraph, start + end);
  else if (at === t.paragraph.closeStart)
    d.patch(t.part, t.xml, [{ start: at, end: at, value: start + end }]);
  else
    d.patch(t.part, t.xml, [
      { start: at, end: at, value: start },
      { start: t.paragraph.closeStart, end: t.paragraph.closeStart, value: end },
    ]);
}
