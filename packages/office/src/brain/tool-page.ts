import type { OfficeDecoded } from "@pibot/office-contract/full";
import { officeContentPage } from "./content-page.ts";

const LIMIT = 24 * 1024;
/** Model output has a smaller complete-JSON budget than the interactive user's preview. */
export function officeToolPage(
  decoded: OfficeDecoded,
  revision: string,
  input: { offset?: number; sheet?: number; limit?: number },
) {
  const requested = Math.min(input.limit ?? 20, 20);
  let count = requested;
  for (;;) {
    const page = officeContentPage(decoded, revision, { ...input, limit: count });
    const nextOffset =
      (input.offset ?? 0) +
      (page.content.kind === "docx"
        ? page.content.blocks.length
        : page.content.kind === "xlsx"
          ? (page.content.sheets[0]?.rows.length ?? 0)
          : page.content.slides.length);
    const result = {
      ...page,
      nextOffset: nextOffset < page.total ? nextOffset : null,
      limit: count,
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") <= LIMIT) return result;
    if (count > 1) {
      count = Math.max(1, Math.floor(count / 2));
      continue;
    }
    let remaining = 1_200;
    const shrink = (value: unknown): unknown => {
      if (typeof value === "string") {
        const result = value.slice(0, Math.max(0, Math.min(200, remaining)));
        remaining -= result.length;
        return result;
      }
      if (Array.isArray(value)) return value.slice(0, 20).map(shrink);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, shrink(entry)]),
        );
      return value;
    };
    return {
      ...result,
      content: shrink(page.content),
      sheetNames: page.sheetNames?.slice(0, 20),
      truncated: true,
      note: "Large element shortened. Read smaller ranges or use the local file preview; no full document was returned. Do not treat shortened text/formulas as complete edit values.",
    };
  }
}
