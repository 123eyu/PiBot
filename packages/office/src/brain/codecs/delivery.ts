import { posix } from "node:path";
import {
  descendants,
  localName,
  nodeText,
  type OfficeArchive,
  parseXml,
  readArchive,
  texts,
  type XmlNode,
} from "./archive.ts";
import { readContent } from "./read.ts";

/** Read the actual archive, never its editable cached model or external relationships. */
export async function deliveryOffice(bytes: Uint8Array, format: "docx" | "xlsx") {
  const files = await readArchive(bytes);
  if (!files.has("[Content_Types].xml") || !files.has("_rels/.rels"))
    throw new Error("office_invalid_document");
  for (const [name, data] of files)
    if (name.endsWith(".xml") || name.endsWith(".rels")) parseXml(data);
  const content = readContent(files, format, format === "docx" ? docxText(files) : undefined);
  const text =
    content.kind === "docx"
      ? content.blocks
          .map((block) =>
            block.type === "table"
              ? block.rows.map((row) => row.join("\t")).join("\n")
              : `${block.type === "heading" ? `${"#".repeat(block.level)} ` : ""}${block.text}`,
          )
          .join("\n")
      : content.kind === "xlsx"
        ? content.sheets
            .map(
              (sheet) =>
                `[${sheet.name}]\n${sheet.rows.map((row) => row.map((cell) => (cell !== null && typeof cell === "object" ? String(cell.cachedValue ?? "") : String(cell ?? ""))).join("\t")).join("\n")}`,
            )
            .join("\n\n")
        : "";
  const columns =
    content.kind === "xlsx"
      ? (content.sheets[0]?.rows[0] ?? []).map((cell) =>
          cell !== null && typeof cell === "object"
            ? String(cell.cachedValue ?? "")
            : String(cell ?? ""),
        )
      : [];
  const root = format === "docx" ? "word/" : "xl/";
  // A loose media file is not an embedded image: require an XML reference through a local rel.
  let hasChart = false;
  const queue = [format === "docx" ? "word/document.xml" : "xl/workbook.xml"];
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const owner = queue[index];
    if (!owner || visited.has(owner)) continue;
    visited.add(owner);
    const ownerData = files.get(owner);
    if (!ownerData) continue;
    const name = posix.join(posix.dirname(owner), "_rels", `${posix.basename(owner)}.rels`);
    const data = files.get(name);
    if (!data) continue;
    const refs = new Set<string>();
    const collect = (nodes: ReturnType<typeof parseXml>) => {
      for (const node of nodes) {
        for (const [key, value] of Object.entries(node.attributes))
          if (key === "r:id" || key === "r:embed") refs.add(value);
        collect(node.children);
      }
    };
    const nodes = parseXml(ownerData);
    collect(nodes);
    const images = new Set(descendants(nodes, "blip").map((node) => node.attributes["r:embed"]));
    const charts = new Set(descendants(nodes, "chart").map((node) => node.attributes["r:id"]));
    for (const rel of descendants(parseXml(data), "Relationship")) {
      const { Id, Target, TargetMode, Type } = rel.attributes;
      if (!Id || !refs.has(Id) || !Target || TargetMode === "External") continue;
      if (/^[a-z]+:|[\\?#]/i.test(Target)) continue;
      const target = posix.normalize(
        Target.startsWith("/") ? Target.slice(1) : posix.join(posix.dirname(owner), Target),
      );
      if (!target.startsWith(root) || !(files.get(target)?.byteLength ?? 0)) continue;
      if (
        (/\/image$/.test(Type ?? "") && images.has(Id)) ||
        (/\/chart$/.test(Type ?? "") && charts.has(Id))
      )
        hasChart = true;
      else if (target.endsWith(".xml")) queue.push(target);
    }
  }
  if (text.length > 2_000_000) throw new Error("office_content_limit");
  return { text, columns, hasChart };
}

/** Project hyperlinks in place: appending destinations duplicates numbered citation labels. */
function docxText(files: OfficeArchive) {
  const rels = files.get("word/_rels/document.xml.rels");
  const targets = new Map<string, string>();
  for (const node of rels ? descendants(parseXml(rels), "Relationship") : []) {
    const { Id, Type, Target } = node.attributes;
    if (
      Id &&
      /\/hyperlink$/.test(Type ?? "") &&
      Target &&
      /^https?:\/\//i.test(Target) &&
      Target.length <= 4000
    )
      targets.set(Id, Target);
  }
  return (nodes: XmlNode[]) => {
    let links = 0;
    const render = (children: XmlNode[]): string =>
      children
        .map((node) => {
          if (localName(node) === "t") return nodeText(node);
          if (localName(node) === "hyperlink") {
            const target = targets.get(node.attributes["r:id"] ?? "");
            const label = texts(node.children);
            // Entities preserve bracketed labels without creating nested Markdown links/code.
            const escaped = label.replace(/[&<>[\]`\\\r\n]/g, (char) =>
              char === "\r" || char === "\n" ? " " : `&#${char.charCodeAt(0)};`,
            );
            return target && links++ < 200 ? `[${escaped}](${target})` : label;
          }
          return render(node.children);
        })
        .join("");
    return render(nodes);
  };
}
