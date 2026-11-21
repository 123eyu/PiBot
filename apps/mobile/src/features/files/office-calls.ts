import { type OfficePreview, OfficePreviewSchema } from "@pibot/protocol";
import type { FileCache } from "../../storage/file-cache.ts";
import type { Caller } from "../chat/controls/scope.ts";
import { type FileSource, sourceKey } from "./source.ts";

/** The phone gateway allows at most 50 items per page (keeps a page under the frame limit). */
export function officePageSize(kind: "docx" | "xlsx" | "pptx") {
  return kind === "pptx" ? 5 : kind === "xlsx" ? 50 : 30;
}
/**
 * One page of the computer's structured Office view (the desktop office.preview), cached per
 * source, sheet and offset so the same pages read offline. The cached JSON is validated again
 * on the way out, like any other input.
 */
export async function readOfficePage(
  c: Caller,
  cache: FileCache,
  input: {
    computerId: string;
    online: boolean;
    source: FileSource;
    limit: number;
    offset: number;
    sheet?: number;
    revision?: string;
  },
  signal?: AbortSignal,
): Promise<{ page: OfficePreview; stale: boolean }> {
  const key = `office:${sourceKey(input.source)}:${input.sheet ?? 0}:${input.offset}:${input.limit}`;
  if (!input.online) {
    const entry = await cache.get(input.computerId, key);
    if (!entry) throw new Error("offline");
    const page = OfficePreviewSchema.parse(JSON.parse(await cache.readText(entry)));
    return { page, stale: true };
  }
  const page = await c.call(
    "office.preview",
    {
      ...input.source,
      requestId: crypto.randomUUID(),
      offset: input.offset,
      limit: input.limit,
      ...(input.sheet !== undefined ? { sheet: input.sheet } : {}),
      // Later pages must come from the same version of the file as the first one.
      ...(input.revision ? { expectedRevision: input.revision } : {}),
    },
    signal,
    60_000,
  );
  await cache.putText(input.computerId, key, page.revision, "office", JSON.stringify(page));
  return { page, stale: false };
}
