import type { OfficeFormat, OfficeRenderCheck } from "@pibot/protocol-base";
import {
  descendants,
  localName,
  nodeText,
  parseXml,
  readArchive,
  type XmlNode,
} from "./archive.ts";
import { mainOfficePart, relatedPart } from "./render-parts.ts";
import { checkSlide } from "./slide-check.ts";

export async function checkOfficeRender(
  bytes: Uint8Array,
  format: OfficeFormat,
  pages: number[],
  review = false,
) {
  const archive = await readArchive(bytes);
  const main = mainOfficePart(archive);
  const xml = new Map<string, XmlNode[]>();
  let activeContent = false;
  let scanBytes = 0;
  let scanComplete = true;
  const scan: string[] = [];
  for (const [name, data] of archive) {
    if (/vbaProject|vbaData|macrosheets|activeX|externalLinks/i.test(name)) activeContent = true;
    if (!/\.(xml|rels)$/i.test(name)) continue;
    const nodes = parseXml(data);
    if (
      name === "[Content_Types].xml" &&
      /macroEnabled|vbaProject|activeX/i.test(new TextDecoder().decode(data))
    )
      activeContent = true;
    if (
      name.endsWith(".rels") &&
      descendants(nodes, "Relationship").some((rel) => rel.attributes.TargetMode === "External")
    )
      activeContent = true;
    // New decks and imported masters need not use Microsoft's conventional part names.
    if (
      name === main ||
      name === "xl/workbook.xml" ||
      (format === "pptx" &&
        (name.endsWith(".rels") ||
          nodes.some((node) =>
            ["sld", "sldLayout", "sldMaster", "theme"].includes(localName(node)),
          )))
    )
      xml.set(name, nodes);
    if (!scanComplete) continue;
    const values = [new TextDecoder().decode(data)];
    // Concatenated XML text also detects a known value split across styled runs.
    for (const node of nodes) values.push(nodeText(node));
    // DrawingML text effects and relationship targets can also use entity-encoded attributes.
    for (const node of walk(nodes)) {
      for (const value of Object.values(node.attributes)) {
        scanBytes += Buffer.byteLength(value) + 1;
        if (scanBytes > 2 * 1024 * 1024) break;
        values.push(value);
      }
      if (scanBytes > 2 * 1024 * 1024) break;
    }
    for (const value of values.slice(0, nodes.length + 1))
      scanBytes += Buffer.byteLength(value) + 1;
    scanComplete = scanBytes <= 2 * 1024 * 1024;
    if (scanComplete) scan.push(...values);
  }
  if (!archive.has(main) || !archive.has("[Content_Types].xml") || !archive.has("_rels/.rels"))
    throw new Error("office_invalid_document");
  const check: OfficeRenderCheck = { pages: [], outOfRange: [], issues: [], activeContent };
  if (format === "pptx") {
    const parts = slideParts(xml, main);
    const size = descendants(xml.get(main) ?? [], "sldSz")[0]?.attributes;
    for (const page of pages) {
      const part = parts[page - 1];
      if (!part) check.outOfRange.push(page);
      else {
        check.pages.push(page);
        check.issues.push(...checkSlide(page, part, size, xml, review ? archive : undefined));
      }
    }
  } else if (format === "xlsx") {
    const total = descendants(xml.get(main) ?? [], "sheet").length;
    for (const page of pages) (page <= total ? check.pages : check.outOfRange).push(page);
  }
  return { check, scan: scanComplete ? scan.join("\n") : null };
}

function* walk(nodes: XmlNode[]): Generator<XmlNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children);
  }
}

function slideParts(xml: Map<string, XmlNode[]>, main: string) {
  return descendants(xml.get(main) ?? [], "sldId").map((item) => {
    const id = Object.entries(item.attributes).find(([key]) => key.endsWith(":id"))?.[1];
    const path = id && relatedPart(xml, main, "slide", id);
    if (!path) throw new Error("office_invalid_relationship");
    return path;
  });
}
