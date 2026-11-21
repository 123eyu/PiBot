import {
  type OfficeContent,
  OfficeContentSchema,
  type OfficeDecoded,
  type OfficeFormat,
} from "@pibot/protocol-base/office-content";
import { OfficePackage } from "../ooxml/package.ts";
import { readPresentationLayouts } from "../ooxml/presentation/index.ts";
import { applyWordOperation } from "../ooxml/word/index.ts";
import {
  archiveDigest,
  MODEL_PART,
  type OfficeArchive,
  packArchive,
  parseXml,
  readArchive,
  requiredXml,
} from "./archive.ts";
import { documentFeatures, hasFormula, readContent, xmlHasUnsafeFields } from "./read.ts";
import { estimatedXlsxTextHeight, validateContent, writeContent } from "./write.ts";

export type { OfficeDecoded } from "@pibot/office-contract/full";

export async function inspectOffice(
  bytes: Uint8Array,
  format: OfficeFormat,
  includePresentationLayouts = false,
): Promise<OfficeDecoded> {
  const files = await checkedArchive(bytes);
  const features = documentFeatures(files);
  const model = readModel(files, format);
  const content = model ?? OfficeContentSchema.parse(readContent(files, format));
  const warnings: string[] = [];
  if (!model) {
    features.unsupported = true;
    warnings.push("office_content_preview_partial");
  }
  if (features.macros) warnings.push("office_macros_not_executed");
  if (features.externalLinks) warnings.push("office_external_links_not_loaded");
  if (hasFormula(content)) warnings.push("office_formula_cached_not_recalculated");
  if (
    content.kind === "xlsx" &&
    content.sheets.some((sheet) =>
      sheet.rows.some((row) =>
        row.some((cell) => {
          const value =
            cell !== null && typeof cell === "object" ? (cell.cachedValue ?? "") : (cell ?? "");
          return estimatedXlsxTextHeight(String(value)) > 409;
        }),
      ),
    )
  )
    warnings.push("office_spreadsheet_row_height_limited");
  if (format === "docx" && xmlHasUnsafeFields(requiredXml(files, "word/document.xml")))
    warnings.push("office_fields_not_evaluated");
  let presentationLayouts: OfficeDecoded["presentationLayouts"];
  if (includePresentationLayouts && format === "pptx") {
    try {
      presentationLayouts = await readPresentationLayouts(bytes);
    } catch {
      // An unsupported catalog (for example Strict OOXML) must not break basic text inspection.
      warnings.push("office_presentation_layout_catalog_unavailable");
    }
  }
  return {
    format,
    content,
    warnings,
    features,
    ...(presentationLayouts ? { presentationLayouts } : {}),
  };
}
export async function createOffice(
  input: OfficeContent,
  images: Record<string, Uint8Array> = {},
  retainedTemplateParts?: Set<string>,
  author = "Pi Bot · Bot",
): Promise<Uint8Array> {
  const content = stableIds(OfficeContentSchema.parse(input));
  validateContent(content);
  const bytes = await writeContent(content, images, retainedTemplateParts);
  if (content.kind === "docx" && content.word) {
    const pkg = await OfficePackage.open(bytes);
    const date = new Date().toISOString();
    for (const op of content.word.operations) applyWordOperation(pkg, op, author, date, images);
    return pkg.write();
  }
  const files = await checkedArchive(bytes);
  const contentTypes = files.get("[Content_Types].xml");
  if (!contentTypes) throw new Error("office_invalid_document");
  const xml = new TextDecoder().decode(contentTypes);
  if (!/Extension=["']json["']/.test(xml))
    files.set(
      "[Content_Types].xml",
      new TextEncoder().encode(
        xml.replace(
          "</Types>",
          '<Default Extension="json" ContentType="application/json"/></Types>',
        ),
      ),
    );
  files.set(
    MODEL_PART,
    new TextEncoder().encode(
      JSON.stringify({ version: 1, digest: archiveDigest(files), content: contentModel(content) }),
    ),
  );
  return packArchive(files);
}
function contentModel(content: OfficeContent): OfficeContent {
  if (content.kind !== "pptx") return content;
  // This compatibility model travels with the deck. Do not persist source machine paths or approvals.
  return {
    kind: "pptx",
    title: content.title,
    theme: content.theme,
    slides: content.slides.map(({ id, title, text, layout, subtitle, secondaryText, notes }) => ({
      id,
      title,
      text,
      layout,
      subtitle,
      secondaryText,
      notes,
    })),
  };
}

async function checkedArchive(bytes: Uint8Array): Promise<OfficeArchive> {
  const files = await readArchive(bytes);
  if (!files.has("[Content_Types].xml") || !files.has("_rels/.rels"))
    throw new Error("office_invalid_document");
  // All XML is checked before any format library or private model is trusted.
  for (const [name, data] of files)
    if (name.endsWith(".xml") || name.endsWith(".rels")) parseXml(data);
  return files;
}
function readModel(files: OfficeArchive, format: OfficeFormat): OfficeContent | undefined {
  const bytes = files.get(MODEL_PART);
  if (!bytes || bytes.byteLength > 2_100_000) return;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return;
  } // A stripped or damaged private part falls back to bounded read-only extraction.
  if (!raw || typeof raw !== "object") return;
  const model = raw as Record<string, unknown>;
  if (model.version !== 1 || model.digest !== archiveDigest(files)) return;
  const parsed = OfficeContentSchema.safeParse(model.content);
  if (!parsed.success || parsed.data.kind !== format) return;
  validateContent(parsed.data);
  return stableIds(parsed.data);
}
function stableIds(content: OfficeContent): OfficeContent {
  if (content.kind === "docx")
    return {
      ...content,
      blocks: content.blocks.map((block, index) => ({ ...block, id: `block-${index}` })),
    };
  if (content.kind === "pptx")
    return {
      ...content,
      slides: content.slides.map((slide, index) => ({ ...slide, id: `slide-${index}` })),
    };
  return content;
}
