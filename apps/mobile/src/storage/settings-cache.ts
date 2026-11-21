import type { LocalData } from "./types.ts";

/**
 * The phone's copy of one settings page and when it was read from the computer. The
 * time sits under its own key so copies written before it existed still read as they are.
 */
export const settingsCacheKey = (computerId: string, page: string) =>
  `cache:${computerId}:settings:${page}`;
const stampKey = (computerId: string, page: string) => `cache:${computerId}:stamp:settings:${page}`;

export async function writeSettingsCache(
  data: LocalData,
  computerId: string,
  page: string,
  value: unknown,
) {
  await data.put(settingsCacheKey(computerId, page), value);
  await data.put(stampKey(computerId, page), new Date().toISOString());
}
/** When the stored copy was read; undefined for copies older than the stamp. */
export async function settingsCachedAt(data: LocalData, computerId: string, page: string) {
  const value = await data.get(stampKey(computerId, page)).catch(() => undefined);
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}
