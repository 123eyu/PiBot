import pathApi from "node:path";
import type { WorkspaceFileAccess } from "@pibot/brain/orchestration-kit";
import { deliveryFile } from "@pibot/brain/orchestration-kit";
import type { DeliveryItem, HandoffSpec } from "@pibot/protocol-base";

/** A diagnostic only: inspect exact declared paths in the frozen root, never search or move. */
export async function diagnoseDeliveryLocations(
  items: DeliveryItem[],
  folder: string,
  context: HandoffSpec["deliveryLocation"],
  parent: AbortSignal,
  access?: WorkspaceFileAccess,
): Promise<DeliveryItem[]> {
  const { resolve } = access?.paths ?? pathApi;
  if (!context) return items;
  const signal = AbortSignal.any([parent, AbortSignal.timeout(5_000)]);
  const originals = new Map(context.originals.map((item) => [item.path, item.original]));
  const found = new Map<string, Promise<DeliveryItem["location"]>>();
  const locate = async (path: string) => {
    const expected = resolve(folder, path);
    for (const candidate of new Set([originals.get(path) ?? path, path])) {
      const actual = resolve(context.workspaceRoot, candidate);
      if (actual === expected || actual.length > 4096 || expected.length > 4096) continue;
      try {
        if (await deliveryFile(context.workspaceRoot, actual, signal, undefined, access))
          return { expected, actual };
      } catch {
        // A failed existence check is not evidence of another location; keep the original result.
        parent.throwIfAborted();
        signal.throwIfAborted();
      }
    }
    return undefined;
  };
  for (const item of items) {
    if (item.reason !== "missing_file" || !item.deliverable) continue;
    let pending = found.get(item.deliverable);
    if (!pending) {
      pending = locate(item.deliverable);
      found.set(item.deliverable, pending);
    }
    const location = await pending;
    if (location) {
      item.reason = "wrong_location";
      item.location = location;
    }
  }
  return items;
}
