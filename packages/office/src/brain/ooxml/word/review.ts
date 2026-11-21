import type { WordReviewPage } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import { attribute, type Element, elements, leafText, type XmlPart } from "../xml.ts";
import { W14, W15, WordDocument } from "./document.ts";

export function wordReview(
  pkg: OfficePackage,
  kind: WordReviewPage["kind"],
  offset: number,
  limit: number,
): WordReviewPage {
  const d = new WordDocument(pkg, "Pi Bot", "");
  const main = pkg.xml(d.main),
    items: { xml: XmlPart; node: Element }[] = [];
  const comments = d.related("comments"),
    extended = pkg
      .relationships(d.main)
      .find(
        (r) => r.type === "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
      )?.target;
  const metadata = extended ? pkg.xml(extended).root.children.filter((n) => n.uri === W15) : [];
  if (kind === "comments") {
    if (comments) {
      const xml = pkg.xml(comments);
      items.push(...d.all(xml, "comment").map((node) => ({ xml, node })));
    }
  } else if (kind === "bookmarks")
    items.push(...d.all(main, "bookmarkStart").map((node) => ({ xml: main, node })));
  else {
    const parts = d.storyParts();
    for (const part of parts) {
      const xml = pkg.xml(part);
      for (const node of elements(xml.root))
        if (
          node.uri === d.uri &&
          [
            "ins",
            "del",
            "moveFrom",
            "moveTo",
            "rPrChange",
            "pPrChange",
            "tblPrChange",
            "trPrChange",
            "tcPrChange",
            "sectPrChange",
          ].includes(node.name)
        )
          items.push({ xml, node });
    }
  }
  const commentIds = new Map<string, string>();
  if (comments) {
    const xml = pkg.xml(comments);
    for (const node of d.all(xml, "comment")) {
      const p = d.all({ source: xml.source, root: node }, "p").at(-1);
      const pid = p && attribute(p, "paraId", W14),
        id = d.attr(node, "id");
      if (pid && id) commentIds.set(pid, id);
    }
  }
  const entries = items.slice(offset, offset + Math.min(20, limit)).map(({ xml, node }) => {
    let text = "";
    const id = d.attr(node, "id") ?? "";
    if (kind === "bookmarks") {
      const ends = d.all(xml, "bookmarkEnd").filter((n) => d.attr(n, "id") === id);
      const end = ends.length === 1 ? ends[0] : undefined;
      if (end && end.start >= node.end)
        text = d
          .all(xml, "t")
          .filter((n) => n.start >= node.end && n.end <= end.start)
          .map((n) => leafText(xml, n) ?? "")
          .join("");
    } else
      text = Array.from(elements(node))
        .filter((n) => n.uri === d.uri && ["t", "delText"].includes(n.name))
        .map((n) => leafText(xml, n) ?? "")
        .join("");
    const p = Array.from(elements(node))
        .filter((n) => n.uri === d.uri && n.name === "p")
        .at(-1),
      pid = p && attribute(p, "paraId", W14);
    const record = pid && metadata.find((n) => attribute(n, "paraId", W15) === pid);
    const author = d.attr(node, "author"),
      date = d.attr(node, "date"),
      parentPara = record ? attribute(record, "paraIdParent", W15) : undefined,
      parent = parentPara ? commentIds.get(parentPara) : undefined;
    return {
      id: id.slice(0, 100),
      type: node.name,
      text: text.slice(0, 1200),
      truncated: text.length > 1200,
      ...(kind === "bookmarks" ? { name: (d.attr(node, "name") ?? "").slice(0, 100) } : {}),
      ...(author !== undefined ? { author: author.slice(0, 200) } : {}),
      ...(date !== undefined ? { date: date.slice(0, 100) } : {}),
      ...(kind === "comments"
        ? {
            resolved: !!record && ["1", "true"].includes(attribute(record, "done", W15) ?? ""),
            ...(parent ? { parent: parent.slice(0, 100) } : {}),
          }
        : {}),
    };
  });
  while (Buffer.byteLength(JSON.stringify(entries), "utf8") > 24 * 1024 && entries.length > 1)
    entries.pop();
  return {
    kind,
    total: items.length,
    offset,
    nextOffset: offset + entries.length < items.length ? offset + entries.length : null,
    entries,
  };
}
