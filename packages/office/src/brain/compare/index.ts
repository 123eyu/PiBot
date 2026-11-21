import type { OfficeChangeItem } from "@pibot/protocol-base";
import type { OfficeFormat } from "@pibot/protocol-base/office-content";
import { OfficePackage } from "../ooxml/package.ts";
import { validatePackage } from "../ooxml/validate.ts";
import type { Change } from "./blocks.ts";
import { excelChanges } from "./excel.ts";
import { presentationChanges } from "./presentation.ts";
import { wordChanges } from "./word.ts";

/** One line per changed object is what the panel lists; beyond this the file-level actions remain. */
const LIMIT = 200;

function changesOf(before: OfficePackage, after: OfficePackage, format: OfficeFormat): Change[] {
  if (format === "docx") return wordChanges(before, after);
  if (format === "xlsx") return excelChanges(before, after);
  return presentationChanges(before, after);
}

export async function diffOffice(
  before: Uint8Array,
  after: Uint8Array,
  format: OfficeFormat,
): Promise<{ items: OfficeChangeItem[]; omitted: number }> {
  const left = await OfficePackage.open(before);
  const right = await OfficePackage.open(after);
  const changes = changesOf(left, right, format);
  return {
    items: changes.slice(0, LIMIT).map((change) => change.item),
    omitted: Math.max(0, changes.length - LIMIT),
  };
}

/**
 * Reverts one object of the newer file to the older file's content. The item is resolved by
 * repeating the same comparison, so the two versions must be the ones the list was built from.
 */
export async function restoreOffice(
  before: Uint8Array,
  after: Uint8Array,
  format: OfficeFormat,
  item: string,
): Promise<Uint8Array | null> {
  const left = await OfficePackage.open(before);
  const right = await OfficePackage.open(after);
  const change = changesOf(left, right, format).find((entry) => entry.item.id === item);
  if (!change?.apply) return null;
  change.apply(right);
  // A restore splices markup from another file: only a document that still validates may ship.
  if (validatePackage(right, format).serious > 0) return null;
  const bytes = right.write();
  await OfficePackage.open(bytes);
  return bytes;
}
