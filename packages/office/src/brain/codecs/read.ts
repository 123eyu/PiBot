import { posix } from "node:path";
import type { OfficeContent, OfficeDecoded, OfficeFormat } from "@pibot/office-contract/full";
import {
  descendants,
  localName,
  nodeText,
  type OfficeArchive,
  requiredXml,
  texts,
  type XmlNode,
} from "./archive.ts";
import { mainOfficePart } from "./render-parts.ts";

type Blocks = Extract<OfficeContent, { kind: "docx" }>["blocks"];
type Cell = Extract<OfficeContent, { kind: "xlsx" }>["sheets"][number]["rows"][number][number];
export function readContent(
  files: OfficeArchive,
  format: OfficeFormat,
  paragraphText: (nodes: XmlNode[]) => string = texts,
): OfficeContent {
  if (format === "docx") return readDocx(files, paragraphText);
  if (format === "xlsx") return readXlsx(files);
  return readPptx(files);
}
function readDocx(
  files: OfficeArchive,
  paragraphText: (nodes: XmlNode[]) => string,
): OfficeContent {
  const body = descendants(requiredXml(files, "word/document.xml"), "body")[0];
  if (!body) throw new Error("office_invalid_document");
  const blocks: Blocks = [];
  for (const child of body.children) {
    const id = `block-${blocks.length}`;
    if (localName(child) === "p") {
      const style = descendants(child.children, "pStyle")[0]?.attributes["w:val"];
      const heading = style?.match(/^Heading([1-6])$/i);
      blocks.push(
        heading
          ? { id, type: "heading", level: Number(heading[1]), text: paragraphText(child.children) }
          : { id, type: "paragraph", text: paragraphText(child.children) },
      );
    } else if (localName(child) === "tbl") {
      const rows = child.children
        .filter((node) => localName(node) === "tr")
        .map((row) =>
          row.children
            .filter((node) => localName(node) === "tc")
            .map((cell) =>
              cell.children
                .filter((node) => localName(node) === "p")
                .map((p) => paragraphText(p.children))
                .join("\n"),
            ),
        );
      blocks.push({ id, type: "table", rows });
    }
    if (blocks.length > 2_000) throw new Error("office_content_limit");
  }
  return { kind: "docx", blocks };
}
function relationshipTargets(files: OfficeArchive, main: string): Map<string, string> {
  const relPath = posix.join(posix.dirname(main), "_rels", `${posix.basename(main)}.rels`);
  const rels = requiredXml(files, relPath);
  const targets = new Map<string, string>();
  for (const rel of descendants(rels, "Relationship")) {
    if (rel.attributes.TargetMode === "External") continue;
    const id = rel.attributes.Id;
    const target = rel.attributes.Target;
    if (!id || !target || target.includes("\\") || /[?#]|^[a-z]+:/i.test(target))
      throw new Error("office_invalid_relationship");
    const resolved = posix.normalize(
      target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(main), target),
    );
    if (resolved.startsWith("../") || !files.has(resolved))
      throw new Error("office_invalid_relationship");
    targets.set(id, resolved);
  }
  return targets;
}
function readXlsx(files: OfficeArchive): OfficeContent {
  const main = "xl/workbook.xml";
  const workbook = requiredXml(files, main);
  const targets = relationshipTargets(files, main);
  const strings = files.has("xl/sharedStrings.xml")
    ? descendants(requiredXml(files, "xl/sharedStrings.xml"), "si").map((node) =>
        texts(node.children),
      )
    : [];
  let cellCount = 0;
  let textBytes = 0;
  const sheets = descendants(workbook, "sheet").map((sheet) => {
    const name = sheet.attributes.name;
    const target = targets.get(sheet.attributes["r:id"] ?? "");
    if (!name || !target) throw new Error("office_invalid_document");
    const rows: Cell[][] = [];
    for (const cell of descendants(requiredXml(files, target), "c")) {
      const address = cell.attributes.r?.match(/^([A-Z]{1,3})([1-9]\d*)$/);
      if (!address) throw new Error("office_invalid_cell");
      const row = Number(address[2]) - 1;
      let column = 0;
      for (const char of address[1] ?? "") column = column * 26 + char.charCodeAt(0) - 64;
      column--;
      if (row >= 5_000 || column >= 100 || ++cellCount > 100_000)
        throw new Error("office_content_limit");
      while (rows.length <= row) rows.push([]);
      const outputRow = rows[row];
      if (!outputRow) throw new Error("office_invalid_cell");
      while (outputRow.length <= column) outputRow.push(null);
      const value = descendants(cell.children, "v")[0];
      const raw = value ? nodeText(value) : "";
      const type = cell.attributes.t;
      const formula = descendants(cell.children, "f")[0];
      let parsed: Cell = null;
      if (type === "s") {
        const index = Number(raw);
        if (!Number.isInteger(index) || strings[index] === undefined)
          throw new Error("office_invalid_cell");
        parsed = strings[index] ?? "";
      } else if (type === "inlineStr") parsed = texts(cell.children);
      else if (type === "b") {
        if (raw !== "0" && raw !== "1") throw new Error("office_invalid_cell");
        parsed = raw === "1";
      } else if (type === "str" || type === "e" || type === "d") parsed = raw;
      else if (raw !== "") {
        const number = Number(raw);
        parsed = Number.isFinite(number) ? number : raw;
      }
      if (formula && !nodeText(formula)) throw new Error("office_unsupported");
      if (formula)
        parsed = {
          formula: nodeText(formula),
          ...(parsed !== null && typeof parsed !== "object" ? { cachedValue: parsed } : {}),
        };
      if (typeof parsed === "string" && parsed.length > 10_000)
        throw new Error("office_content_limit");
      if (parsed !== null && typeof parsed === "object" && parsed.formula.length > 2_000)
        throw new Error("office_content_limit");
      textBytes += Buffer.byteLength(
        typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed ?? ""),
        "utf8",
      );
      if (textBytes > 2 * 1024 * 1024) throw new Error("office_content_limit");
      outputRow[column] = parsed;
    }
    return { name, rows };
  });
  return { kind: "xlsx", sheets };
}
function readPptx(files: OfficeArchive): OfficeContent {
  const main = mainOfficePart(files);
  const presentation = requiredXml(files, main);
  const targets = relationshipTargets(files, main);
  const slides = descendants(presentation, "sldId").map((id, index) => {
    const relationId = Object.entries(id.attributes).find(([key]) => key.endsWith(":id"))?.[1];
    const target = targets.get(relationId ?? "");
    if (!target) throw new Error("office_invalid_document");
    const slide = requiredXml(files, target);
    const paragraphs = descendants(slide, "p")
      .map((node) => texts(node.children))
      .filter(Boolean);
    return {
      id: `slide-${index}`,
      title: paragraphs[0] ?? "",
      text: paragraphs.slice(1).join("\n"),
    };
  });
  return { kind: "pptx", slides };
}
export function documentFeatures(files: OfficeArchive): OfficeDecoded["features"] {
  let macros = false;
  let externalLinks = false;
  let unsupported = false;
  for (const [name, data] of files) {
    if (/vbaProject|vbaData|macrosheets|activeX|\.bin$|oleObject/i.test(name)) macros = true;
    if (/externalLinks\//i.test(name)) externalLinks = true;
    if (
      /drawing|chart|pivot|comments|notesSlides|footnotes|endnotes|slicer|customXml/i.test(name) ||
      (name.includes("embeddings/") && !name.endsWith(".bin"))
    )
      unsupported = true;
    if (name.endsWith(".rels")) {
      for (const relationship of descendants(requiredXml(files, name), "Relationship"))
        if (relationship.attributes.TargetMode === "External") externalLinks = true;
    } else if (
      name === "[Content_Types].xml" &&
      /macroEnabled|vbaProject|activeX/i.test(new TextDecoder().decode(data))
    )
      macros = true;
  }
  return { macros, externalLinks, encrypted: false, unsupported };
}
export function hasFormula(content: OfficeContent): boolean {
  return (
    content.kind === "xlsx" &&
    content.sheets.some((sheet) =>
      sheet.rows.some((row) => row.some((cell) => cell !== null && typeof cell === "object")),
    )
  );
}
export function xmlHasUnsafeFields(nodes: XmlNode[]): boolean {
  return descendants(nodes, "instrText").length > 0 || descendants(nodes, "fldSimple").length > 0;
}
