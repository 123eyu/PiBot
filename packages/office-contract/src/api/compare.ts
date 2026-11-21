import type { OfficeChangeItem } from "@pibot/protocol-base";

/**
 * The name workspaces asks for. Office provides it from its brain capability, so the
 * changes panel depends on this contract only and never on the office implementation.
 */
export const OFFICE_COMPARE_PORT = "office-compare";

export type OfficeCompareFormat = "docx" | "xlsx" | "pptx";

/**
 * Compares two versions of one file by its own structure (slides and shapes, paragraphs and
 * tables, sheet ranges and charts) instead of by bytes, and restores a single object.
 *
 * Restore resolves the item id against the same pair again, so the caller must pass exactly the
 * two versions the list was built from; a stale file is refused before this is reached.
 */
export interface OfficeComparePort {
  diff(input: {
    format: OfficeCompareFormat;
    before: Uint8Array;
    after: Uint8Array;
    signal: AbortSignal;
  }): Promise<{ items: OfficeChangeItem[]; omitted: number }>;
  /** The newer version with that one object taken back from the older one; null when impossible. */
  restore(input: {
    format: OfficeCompareFormat;
    before: Uint8Array;
    after: Uint8Array;
    item: string;
    signal: AbortSignal;
  }): Promise<Uint8Array | null>;
}
