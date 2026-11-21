import type { OfficeDecoded } from "@pibot/office-contract/full";

const CACHE_LIMIT = 1_000_000;
export function extractOfficeText(decoded: OfficeDecoded) {
  const content = decoded.content;
  const text =
    content.kind === "xlsx"
      ? content.sheets
          .map(
            (sheet) =>
              `[${sheet.name}]\n${sheet.rows.map((row) => row.map((cell) => (typeof cell === "object" && cell !== null ? `=${cell.formula} [cached: ${cell.cachedValue ?? "unknown"}]` : (cell ?? ""))).join("\t")).join("\n")}`,
          )
          .join("\n\n")
      : content.kind === "pptx"
        ? content.slides
            .map((slide, index) => `[Slide ${index + 1}] ${slide.title ?? ""}\n${slide.text ?? ""}`)
            .join("\n\n")
        : "";
  return { text: text.slice(0, CACHE_LIMIT), totalChars: text.length, scanned: false, pages: 0 };
}
