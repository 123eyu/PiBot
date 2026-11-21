import type { OfficeStructureItem } from "@pibot/protocol-base/office-content";

export const ITEM_BYTES = 4096;
/** Shrink strings together, preserving typed keys, item identity and pagination. */
export function boundItem(item: OfficeStructureItem, clipped = false): OfficeStructureItem {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  let result = clipped ? { ...item, truncated: true } : item;
  let max = 1000;
  while (size(result) > ITEM_BYTES) {
    const shrink = (value: unknown): unknown => {
      if (typeof value === "string") return value.slice(0, max).replace(/[\uD800-\uDBFF]$/u, "");
      if (Array.isArray(value)) return value.map(shrink);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            key === "kind" || key === "coverage" ? entry : shrink(entry),
          ]),
        );
      return value;
    };
    result = { ...(shrink(result) as OfficeStructureItem), truncated: true };
    max = Math.floor(max / 2);
  }
  return result;
}
