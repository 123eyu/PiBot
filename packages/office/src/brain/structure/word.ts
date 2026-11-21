import type { OfficeStructureItem } from "@pibot/protocol-base/office-content";
import { type Element, elements, type XmlPart } from "../ooxml/xml.ts";
import type { StructureContext } from "./page.ts";
import { headingStyles } from "./word-styles.ts";
import {
  attr,
  belongs,
  byKind,
  child,
  DRAW,
  nodes,
  relations,
  relId,
  target,
  WORD,
  wordAttr,
} from "./xml.ts";

const REVISIONS = new Set([
  "ins",
  "del",
  "moveFrom",
  "moveTo",
  "pPrChange",
  "rPrChange",
  "sectPrChange",
  "tblPrChange",
  "trPrChange",
  "tcPrChange",
  "tblGridChange",
  "cellIns",
  "cellDel",
  "cellMerge",
]);

export function* wordStructure(ctx: StructureContext): Generator<OfficeStructureItem> {
  const { pkg, summary } = ctx;
  const main = pkg.mainPart(),
    xml = pkg.xml(main);
  if (xml.root.name !== "document" || !belongs(xml.root, WORD))
    throw new Error("office_invalid_document");
  const references = new Map<string, "header" | "footer">();
  yield* bodyItems(ctx, xml, main, references);
  yield* images(ctx, main, xml.root);
  const rels = relations(pkg, main);
  let comments = 0;
  for (const part of byKind(rels, "comments")) {
    const story = pkg.optional(part, main);
    if (story) for (const _node of nodes(story.root, "comment", WORD)) comments++;
  }
  summary.comments = comments;
  for (const [part, type] of references) {
    const story = pkg.optional(part, main);
    if (!story) continue;
    yield {
      kind: "header_footer",
      type,
      part,
      text: ctx.budget.text(story, story.root, WORD, " "),
    };
    yield* images(ctx, part, story.root);
  }
}
function* bodyItems(
  ctx: StructureContext,
  xml: XmlPart,
  main: string,
  references: Map<string, "header" | "footer">,
): Generator<OfficeStructureItem> {
  const styles =
    ctx.query.collection && ctx.query.collection !== "heading"
      ? new Map<string, number>()
      : headingStyles(ctx, main);
  const historical = new Set<Element>();
  for (const change of nodes(xml.root, "sectPrChange", WORD))
    for (const old of nodes(change, "sectPr", WORD)) historical.add(old);
  let paragraph = 0,
    section = 0;
  const kinds: Record<string, number> = {};
  for (const node of elements(xml.root)) {
    if (!belongs(node, WORD)) continue;
    if (REVISIONS.has(node.name)) kinds[node.name] = (kinds[node.name] ?? 0) + 1;
    if (["instrText", "fldSimple"].includes(node.name)) ctx.summary.fields = true;
    if (node.name === "p") {
      paragraph++;
      const level = headingLevel(node, styles);
      if (level)
        yield { kind: "heading", paragraph, level, text: ctx.budget.text(xml, node, WORD) };
    } else if (node.name === "bookmarkStart") {
      yield {
        kind: "bookmark",
        name: ctx.budget.clip(wordAttr(node, "name")) ?? "",
        id: ctx.budget.clip(wordAttr(node, "id")),
        paragraph: paragraph || undefined,
      };
    } else if (node.name === "tbl") yield tableItem(node);
    else if (node.name === "sectPr" && !historical.has(node))
      yield sectionItem(ctx, node, main, ++section, references);
  }
  ctx.summary.revisionKinds = kinds;
  ctx.summary.revisions = Object.values(kinds).reduce((sum, count) => sum + count, 0);
}
function headingLevel(node: Element, styles: Map<string, number>) {
  const props = child(node, "pPr", WORD);
  const raw = wordAttr(props && child(props, "outlineLvl", WORD), "val");
  const style = wordAttr(props && child(props, "pStyle", WORD), "val");
  const conventional = /^Heading([1-9])$/iu.exec(style ?? "")?.[1];
  return raw !== undefined
    ? /^[0-8]$/u.test(raw)
      ? Number(raw) + 1
      : undefined
    : (styles.get(style ?? "") ?? (conventional ? Number(conventional) : undefined));
}
function tableItem(node: Element): OfficeStructureItem {
  const rows = node.children.filter((item) => item.name === "tr" && belongs(item, WORD));
  let columns = 0;
  for (const row of rows)
    columns = Math.max(
      columns,
      row.children.filter((item) => item.name === "tc" && belongs(item, WORD)).length,
    );
  return { kind: "word_table", rows: rows.length, columns };
}
function sectionItem(
  ctx: StructureContext,
  node: Element,
  main: string,
  section: number,
  stories: Map<string, "header" | "footer">,
): OfficeStructureItem {
  const refs: Extract<OfficeStructureItem, { kind: "section" }>["references"] = [];
  const rels = relations(ctx.pkg, main);
  for (const ref of node.children) {
    const kind =
      ref.name === "headerReference"
        ? "header"
        : ref.name === "footerReference"
          ? "footer"
          : undefined;
    if (!kind || !belongs(ref, WORD)) continue;
    const part = target(rels, ref, kind);
    if (!part) {
      ctx.pkg.problem(main, "missing_part");
      continue;
    }
    stories.set(part, kind);
    refs.push({ kind, type: ctx.budget.clip(wordAttr(ref, "type")) ?? "default", part });
  }
  if (refs.length > 6) throw new Error("office_invalid_document");
  return { kind: "section", section, references: refs };
}
function* activeElements(root: Element): Generator<Element> {
  yield root;
  if (
    root.uri === "http://schemas.openxmlformats.org/markup-compatibility/2006" &&
    root.name === "AlternateContent"
  ) {
    const chosen =
      root.children.find((node) => node.name === "Choice") ??
      root.children.find((node) => node.name === "Fallback");
    if (chosen) yield* activeElements(chosen);
  } else for (const node of root.children) yield* activeElements(node);
}
function* images(
  ctx: StructureContext,
  ownerPart: string,
  root: Element,
): Generator<OfficeStructureItem> {
  const rels = relations(ctx.pkg, ownerPart);
  for (const node of activeElements(root)) {
    if (node.name === "blip" && belongs(node, DRAW)) {
      const rel = rels.get(relId(node, "embed") ?? relId(node, "link") ?? "");
      yield { kind: "image", ownerPart, part: rel?.kind === "image" ? rel.part : undefined };
    } else if (node.name === "imagedata" && node.uri === "urn:schemas-microsoft-com:vml") {
      yield {
        kind: "image",
        ownerPart,
        part: target(rels, node, "image"),
        description: ctx.budget.clip(attr(node, "title")),
      };
    }
  }
}
