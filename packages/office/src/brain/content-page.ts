import type { OfficeContent, OfficeDecoded, OfficePreview } from "@pibot/office-contract/full";
import { OfficeError } from "./errors.ts";

export function officeContentPage(
  document: OfficeDecoded,
  revision: string,
  input: { offset?: number; limit?: number; sheet?: number; page?: number },
): OfficePreview {
  const source = document.content;
  const offset = input.offset ?? input.page ?? 0;
  const limit = input.limit ?? (source.kind === "pptx" ? 1 : source.kind === "xlsx" ? 100 : 30);
  let clipped = false;
  let budget = 160_000;
  const text = (value: string, max = 16_000) => {
    const available = Math.max(0, Math.min(max, budget));
    budget -= Math.min(value.length, available);
    clipped ||= value.length > available;
    return value.slice(0, available);
  };
  let content: OfficeContent;
  let total: number;
  let sheetNames: string[] | undefined;
  let sheetIndex: number | undefined;
  if (source.kind === "docx") {
    total = source.blocks.length;
    content = {
      kind: "docx",
      title: source.title,
      blocks: source.blocks.slice(offset, offset + limit).map((block) =>
        block.type === "table"
          ? {
              ...block,
              rows: block.rows.slice(0, 100).map((row) => row.map((cell) => text(cell, 1_000))),
            }
          : { ...block, text: text(block.text) },
      ),
    };
    clipped ||= source.blocks
      .slice(offset, offset + limit)
      .some((block) => block.type === "table" && block.rows.length > 100);
  } else if (source.kind === "xlsx") {
    sheetIndex = input.sheet ?? 0;
    const sheet = source.sheets[sheetIndex];
    if (!sheet) throw new OfficeError("office_invalid");
    sheetNames = source.sheets.map((item) => item.name);
    total = sheet.rows.length;
    content = {
      kind: "xlsx",
      sheets: [
        {
          name: sheet.name,
          rows: sheet.rows.slice(offset, offset + limit).map((row) =>
            row.map((cell) =>
              typeof cell === "string"
                ? text(cell, 1_000)
                : cell && typeof cell === "object"
                  ? {
                      ...cell,
                      cachedValue:
                        typeof cell.cachedValue === "string"
                          ? text(cell.cachedValue, 1_000)
                          : cell.cachedValue,
                    }
                  : cell,
            ),
          ),
        },
      ],
    };
  } else {
    total = source.slides.length;
    const slides = source.slides.slice(offset, offset + limit);
    if (!slides.length) throw new OfficeError("office_invalid");
    content = {
      kind: "pptx",
      title: source.title,
      slides: slides.map((slide) => ({
        ...slide,
        title: slide.title ? text(slide.title, 500) : undefined,
        text: slide.text ? text(slide.text) : undefined,
      })),
    };
  }
  return {
    format: document.format,
    revision,
    content,
    warnings: document.warnings,
    total,
    truncated: clipped,
    ...(sheetNames ? { sheetNames, sheetIndex } : {}),
  };
}
