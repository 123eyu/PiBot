import pathApi from "node:path";
import type { DeliverySources, OfficePort } from "@pibot/brain/orchestration-kit";
import { checkDelivery, deliveryFile } from "@pibot/brain/orchestration-kit";
import type { DeliveryItem, HandoffResult } from "@pibot/protocol-base";
import type { HandoffRecord } from "@pibot/storage";
import { diagnoseDeliveryLocations } from "./group-delivery-location.ts";

/**
 * What the program can judge of a finished hand-off, with the same item shape as workflow
 * delivery checks: each expected file present and non-empty (never through a link), then the
 * selected acceptance items of the member's workflow contract. Local reads only, no model.
 */
export async function checkHandoff(
  record: HandoffRecord,
  office: OfficePort | undefined,
  signal: AbortSignal,
  sources?: DeliverySources,
): Promise<DeliveryItem[]> {
  const base = record.baseFolder;
  const items: DeliveryItem[] = [];
  for (const [index, path] of record.spec.files.entries()) {
    const item = { id: fileItemId(index), check: "exists" as const, deliverable: path, text: null };
    if (!base) {
      items.push({ ...item, status: "manual", reason: "unreadable", missing: [] });
      continue;
    }
    let info: { size: number } | undefined;
    for (const candidate of handoffPaths(base, path, sources?.access?.paths)) {
      info = await deliveryFile(base, candidate, signal, undefined, sources?.access).catch(
        (error: unknown) => {
          if (sources?.access?.remote) throw error;
          return undefined;
        },
      );
      signal.throwIfAborted();
      if (info) break;
    }
    items.push(
      !info
        ? { ...item, status: "fail", reason: "missing_file", missing: [] }
        : info.size === 0
          ? { ...item, status: "fail", reason: "empty_file", missing: [] }
          : { ...item, status: "pass", reason: null, missing: [] },
    );
  }
  if (record.spec.acceptance.length && base)
    items.push(
      ...(await checkDelivery(
        { deliverables: record.spec.deliverables, acceptance: record.spec.acceptance },
        base,
        office,
        signal,
        sources,
      )),
    );
  return base
    ? diagnoseDeliveryLocations(items, base, record.spec.deliveryLocation, signal, sources?.access)
    : items;
}

/**
 * Where an expected file may be: relative to the hand-off's folder (`data.md`), or written from the
 * primary folder down to that same folder (`.pibot/out/周期简报/2026-10-23/data.md`), which models
 * do. A leading part only counts when it repeats the folder's own
 * trailing segments, so the result always stays inside the folder.
 */
export function handoffPaths(base: string, path: string, pathFunctions = pathApi): string[] {
  const { join } = pathFunctions;
  const parts = path.split(/[\\/]/).filter(Boolean);
  const tail = base.split(/[\\/]/).filter(Boolean);
  const paths = [join(base, ...parts)];
  for (let k = 1; k < parts.length && k <= tail.length; k++)
    if (parts.slice(0, k).every((part, i) => part === tail[tail.length - k + i]))
      paths.push(join(base, ...parts.slice(k)));
  return paths;
}

/** `#n` cannot collide with a contract acceptance id (letters, digits, `_` and `-` only). */
export function fileItemId(index: number) {
  return `#${index + 1}`;
}

/** Unmet = a program-judged item failed; a user's own completion or an unavailable check is not. */
export function handoffUnmet(result: HandoffResult) {
  return (
    !result.userResolved &&
    !result.unavailable &&
    result.items.some((item) => item.status === "fail")
  );
}
