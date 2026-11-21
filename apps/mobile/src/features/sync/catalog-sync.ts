import { Methods } from "@pibot/protocol";
import { cachedRead } from "../../storage/cached-read.ts";
import { writeSettingsCache } from "../../storage/settings-cache.ts";
import type { MobileStorage } from "../../storage/state.ts";
import type { Caller } from "../chat/controls/scope.ts";
import type { Conversation } from "../conversations/model.ts";
import { endpointPageSize } from "../endpoints/model.ts";
import { readBotSettings, readGroupSettings } from "../settings/calls.ts";

/**
 * Maintainers 2026-11-14: what changes rarely is kept on the phone ahead of time and refreshed on a
 * timer, so its pages open at once; conversations, tasks and approvals stay live reads.
 */
export const CATALOG_REFRESH_MS = 15 * 60_000;
export const CATALOG_LIMITS = {
  bots: 40,
  groups: 20,
  /** The most recent Bots also get their skills and connections pages. */
  botPages: 8,
} as const;
/** Same key and page size as the Devices tab's list (features/endpoints/DeviceList.tsx). */
export const DEVICE_LIST_KEY = "endpoint-devices:10:";

/** What to refresh: everything, or what a change event named. */
export interface CatalogWork {
  all?: boolean;
  bots?: readonly string[];
  groups?: readonly string[];
  devices?: boolean;
}
export function mergeCatalogWork(a: CatalogWork, b: CatalogWork): CatalogWork {
  return {
    all: a.all || b.all,
    bots: [...new Set([...(a.bots ?? []), ...(b.bots ?? [])])],
    groups: [...new Set([...(a.groups ?? []), ...(b.groups ?? [])])],
    devices: a.devices || b.devices,
  };
}

/** One page that fails (gone, older computer) must not stop the others. */
async function each(signal: AbortSignal, work: () => Promise<unknown>) {
  signal.throwIfAborted();
  try {
    await work();
  } catch (error) {
    if (signal.aborted) throw error;
  }
}
/**
 * Refreshes the stored copies the settings pages and the device list read (under their own
 * keys), one request at a time. Only what the pages already store is written: profiles, skills,
 * connections and group settings carry no keys or tokens.
 */
export async function syncCatalog(
  c: Caller,
  storage: MobileStorage,
  computerId: string,
  rows: readonly Conversation[],
  work: CatalogWork,
  signal: AbortSignal,
) {
  const named = (kind: "bot" | "group", ids: readonly string[] | undefined) => {
    const all = rows.filter((row) => row.kind === kind);
    return work.all ? all : all.filter((row) => ids?.includes(row.id));
  };
  // The ranks come from the whole list, so a named Bot gets the same pages as in a full pass.
  const rank = new Map(
    rows
      .filter((row) => row.kind === "bot")
      .slice(0, CATALOG_LIMITS.bots)
      .map((row, index) => [row.id, index]),
  );
  const ranked = (ids: readonly string[] | undefined) =>
    named("bot", ids).filter((row) => rank.has(row.id));
  const groups = new Set(
    rows
      .filter((row) => row.kind === "group")
      .slice(0, CATALOG_LIMITS.groups)
      .map((row) => row.id),
  );
  if (work.all || work.devices) {
    let devices: readonly { id: string }[] = [];
    await each(signal, async () => {
      const { value } = await cachedRead(
        storage.files,
        {
          computerId,
          online: true,
          key: DEVICE_LIST_KEY,
          schema: Methods["devices.endpoints"].result,
          signal,
        },
        () => c.call("devices.endpoints", { limit: 10 }, signal),
      );
      devices = value.items;
    });
    // v0.0.2 B14: with the computer off, a runner's page said "not cached yet" although the phone
    // may control that runner then. Each device's first capability page is kept ahead, under the
    // detail page's own key (features/endpoints/use-endpoint-page.ts).
    for (const device of devices)
      await each(signal, () =>
        cachedRead(
          storage.files,
          {
            computerId,
            online: true,
            key: `endpoint-capabilities:${device.id}:`,
            schema: Methods["endpoints.list"].result,
            signal,
          },
          () =>
            c.call("endpoints.list", { limit: endpointPageSize, endpointId: device.id }, signal),
        ),
      );
  }
  for (const row of ranked(work.bots)) {
    const recent = (rank.get(row.id) ?? CATALOG_LIMITS.botPages) < CATALOG_LIMITS.botPages;
    for (const page of recent ? [undefined, "skills", "connectors"] : [undefined])
      await each(signal, async () => {
        const value = await readBotSettings(c, row.id, signal, page);
        // A partial answer would later show as "could not load"; the page reads it live instead.
        if (value.resourcesUnavailable) return;
        const key = `bot:${row.id}:${page ?? "profile"}`;
        await writeSettingsCache(storage.data, computerId, key, value);
      });
  }
  for (const row of named("group", work.groups).filter((row) => groups.has(row.id)))
    await each(signal, async () => {
      const value = await readGroupSettings(c, row.id, signal);
      await writeSettingsCache(storage.data, computerId, `group:${row.id}`, value);
    });
}
