import { one } from "../locate.ts";
import { attribute } from "../xml.ts";
import { anchorComment, anchorReply, parentParagraph } from "./comment-anchors.ts";
import { commentEx, extended, paragraphId } from "./comment-parts.ts";
import { W14, W15, type WordDocument, type WordOperation } from "./document.ts";

export function comment(d: WordDocument, op: Extract<WordOperation, { op: "word_comment" }>) {
  const part = d.part("comments", "comments");
  let xml = d.pkg.xml(part);
  const existing =
    op.id === undefined
      ? undefined
      : one(d.all(xml, "comment").filter((n) => d.attr(n, "id") === op.id));
  if (op.action !== "add" && !existing) throw new Error("office_invalid");
  const parent = parentParagraph(d, part, existing);
  xml = d.pkg.xml(part);
  const ex = extended(d);
  if (op.action === "resolve") {
    const exXml = d.pkg.xml(ex),
      record = exXml.root.children.find((n) => attribute(n, "paraId", W15) === parent);
    if (!parent) throw new Error("office_invalid");
    commentEx(d, ex, parent, record && attribute(record, "paraIdParent", W15), true);
    return;
  }
  if (op.text === undefined) throw new Error("office_invalid");
  if (op.action === "add" && (!op.locator || op.id !== undefined))
    throw new Error("office_invalid");
  const id = d.nextStoryId(),
    paraId = paragraphId(d);
  const p = d
    .tag("p", {}, d.run(op.text))
    .replace(" xmlns:w=", ` xmlns:w14="${W14}" w14:paraId="${paraId}" xmlns:w=`);
  d.insert(part, xml, xml.root, d.tag("comment", { id, author: d.author, date: d.date }, p));
  if (parent) {
    const extXml = d.pkg.xml(ex);
    if (!extXml.root.children.some((n) => attribute(n, "paraId", W15) === parent))
      commentEx(d, ex, parent);
  }
  commentEx(d, ex, paraId, op.action === "reply" ? parent : undefined);
  if (op.action === "add") {
    if (!op.locator) throw new Error("office_invalid");
    anchorComment(d, op.locator, id);
  } else {
    if (!op.id) throw new Error("office_invalid");
    anchorReply(d, op.id, id);
  }
}
export function footnote(d: WordDocument, op: Extract<WordOperation, { op: "word_footnote" }>) {
  const part = d.part("footnotes", "footnotes");
  let xml = d.pkg.xml(part);
  if (!d.all(xml, "footnote").length) {
    d.insert(
      part,
      xml,
      xml.root,
      d.tag(
        "footnote",
        { type: "separator", id: -1 },
        d.tag("p", {}, d.tag("r", {}, d.tag("separator"))),
      ) +
        d.tag(
          "footnote",
          { type: "continuationSeparator", id: 0 },
          d.tag("p", {}, d.tag("r", {}, d.tag("continuationSeparator"))),
        ),
    );
    xml = d.pkg.xml(part);
  }
  const id = d.nextId(["footnote"], [part]);
  d.insert(
    part,
    xml,
    xml.root,
    d.tag(
      "footnote",
      { id },
      d.tag(
        "p",
        {},
        d.tag(
          "r",
          {},
          d.tag(
            "rPr",
            {},
            d.tag("rStyle", { val: "FootnoteReference" }) +
              d.tag("vertAlign", { val: "superscript" }),
          ) + d.tag("footnoteRef"),
        ) + d.run(` ${op.text}`),
      ),
    ),
  );
  const t = d.paragraph(op.locator);
  d.insert(
    t.part,
    t.xml,
    t.paragraph,
    d.tag(
      "r",
      {},
      d.tag(
        "rPr",
        {},
        d.tag("rStyle", { val: "FootnoteReference" }) + d.tag("vertAlign", { val: "superscript" }),
      ) + d.tag("footnoteReference", { id }),
    ),
  );
}
