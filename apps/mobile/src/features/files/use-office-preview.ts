import type { OfficePreview } from "@pibot/protocol";
import { useEffect, useRef, useState } from "react";
import type { MobileKey } from "../../i18n/messages.ts";
import { useLinkState, useRuntime } from "../../runtime/context.tsx";
import { fileErrorKey } from "./errors.ts";
import { officePageSize, readOfficePage } from "./office-calls.ts";
import type { FileSource } from "./source.ts";

export function pageItems(page: OfficePreview) {
  const content = page.content;
  if (content.kind === "docx") return content.blocks.length;
  if (content.kind === "xlsx") return content.sheets[0]?.rows.length ?? 0;
  return content.slides.length;
}
/** Paged Office content of one file; switching sheets starts over, "more" continues the revision. */
export function useOfficePreview(source: FileSource | undefined, format: "docx" | "xlsx" | "pptx") {
  const runtime = useRuntime(),
    mobile = useLinkState();
  const [pages, setPages] = useState<OfficePreview[]>([]);
  const [sheet, setSheet] = useState(0);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MobileKey>();
  const [attempt, setAttempt] = useState(0);
  const owner = useRef<AbortController | undefined>(undefined);
  const shown = useRef("");
  const online = mobile.status === "online";
  const key = source ? JSON.stringify(source) : "";
  const read = async (offset: number, revision: string | undefined, reset: boolean) => {
    const computerId = mobile.selectedId;
    if (!source || !computerId) return;
    if (reset) owner.current?.abort();
    const abort = reset || !owner.current ? new AbortController() : owner.current;
    owner.current = abort;
    setBusy(true);
    setError(undefined);
    try {
      const result = await readOfficePage(
        runtime,
        runtime.storage.files,
        {
          computerId,
          online,
          source,
          limit: officePageSize(format),
          offset,
          ...(format === "xlsx" ? { sheet } : {}),
          revision,
        },
        abort.signal,
      );
      if (abort.signal.aborted) return;
      setPages((current) => (reset ? [result.page] : [...current, result.page]));
      setStale(result.stale);
    } catch (cause) {
      if (!abort.signal.aborted) setError(fileErrorKey(cause));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: source, sheet and connection own the first page.
  useEffect(() => {
    // A reconnect re-reads the first page in place; another file or sheet starts empty.
    if (shown.current !== `${key}:${sheet}`) setPages([]);
    shown.current = `${key}:${sheet}`;
    void read(0, undefined, true);
    return () => owner.current?.abort();
  }, [key, sheet, mobile.selectedId, mobile.peer, online, attempt]);
  const first = pages[0];
  const loaded = pages.reduce((sum, page) => sum + pageItems(page), 0);
  return {
    pages,
    first,
    stale,
    busy,
    error,
    sheet,
    // An empty page would never advance the offset.
    hasMore: !!first && loaded < first.total && pageItems(pages.at(-1) as OfficePreview) > 0,
    more: () => {
      if (!busy && first) void read(loaded, first.revision, false);
    },
    selectSheet: (index: number) => setSheet(index),
    retry: () => setAttempt((n) => n + 1),
  };
}
