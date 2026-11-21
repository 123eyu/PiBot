// Keep cloud availability and fixed failure messages consistent across both pickers.
import type { TranslationKey } from "@pibot/i18n";
import { type RoleCatalogEntry, RpcError, RpcErrorCodes } from "@pibot/protocol";

export function catalogCandidates(entries: readonly RoleCatalogEntry[], kind: "role" | "group") {
  return entries.filter(
    (entry) =>
      entry.kind === kind &&
      ((entry.bundled === null && entry.installed === null) ||
        entry.version > Math.max(entry.bundled ?? 0, entry.installed ?? 0)),
  );
}

export function catalogMatches(entry: RoleCatalogEntry, language: "zh" | "en", query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return [
    entry.name[language],
    entry.description[language],
    entry.title?.[language],
    entry.summary?.[language],
  ].some((text) => text?.toLocaleLowerCase().includes(needle));
}

export function catalogFailure(error: unknown): TranslationKey {
  if (!(error instanceof RpcError)) return "builtin.cloud.failed";
  if (error.code === RpcErrorCodes.timeout || error.code === RpcErrorCodes.closed)
    return "builtin.cloud.uncertain";
  switch (error.message) {
    case "role_catalog_offline":
      return "builtin.cloud.offline";
    case "role_catalog_server":
      return "builtin.cloud.server";
    case "role_catalog_signature":
    case "role_catalog_format":
    case "role_catalog_too_large":
    case "role_catalog_archive_mismatch":
      return "builtin.cloud.integrity";
    case "role_catalog_app_too_old":
      return "builtin.cloud.appTooOld";
    default:
      return "builtin.cloud.failed";
  }
}

/** Prefer fresh parent props once they include the installed version (models may have changed). */
export function withInstalled<T extends { id: string; version: number }>(
  local: readonly T[],
  installed: readonly T[] = [],
): T[] {
  const merged = new Map(local.map((item) => [item.id, item]));
  for (const item of installed) {
    const previous = merged.get(item.id);
    if (!previous || item.version > previous.version) merged.set(item.id, item);
  }
  return [...merged.values()];
}
