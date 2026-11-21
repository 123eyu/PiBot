import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { z } from "zod";
import type { FileCache } from "../../storage/file-cache.ts";
import type { Caller } from "../chat/controls/scope.ts";
import { isFailed, logRunId, RECORD_LIMITS, type RecordRow } from "./model.ts";

/**
 * A run's execution log as far as the phone has read it: pages of the computer's redacted view
 * (the computer caps a phone page so each reply fits one frame). Kept in the 500 MB file cache,
 * so it is bounded by the LRU and cleared on unpair with the files.
 */
export const RunLogSchema = z.object({
  pages: z.array(z.string()).max(64),
  nextOffset: z.number().int().nonnegative().nullable(),
  totalBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type RunLog = z.infer<typeof RunLogSchema>;
/** Pages shown on the phone; the rest of a very long log stays on the computer. */
export const MAX_LOG_PAGES = 8;
export const logKey = (runId: string) => `runlog:${runId}`;
const EMPTY_LOG: RunLog = { pages: [], nextOffset: null, totalBytes: 0, truncated: false };

async function cachedLog(cache: FileCache, computerId: string, runId: string) {
  const entry = await cache.get(computerId, logKey(runId));
  if (!entry) return undefined;
  const parsed = RunLogSchema.safeParse(JSON.parse(await cache.readText(entry)));
  return parsed.success ? parsed.data : undefined;
}
function store(cache: FileCache, computerId: string, runId: string, log: RunLog) {
  return cache.putText(computerId, logKey(runId), `${log.totalBytes}`, "json", JSON.stringify(log));
}
async function page(c: Caller, runId: string, offset: number, signal?: AbortSignal) {
  return c.call("runs.readLog", { runId, ...(offset ? { offset } : {}) }, signal, 30_000);
}
/**
 * Opens a log: offline the stored pages; online the first page, keeping the stored pages when
 * the log has not grown since (a finished run's log never changes).
 */
export async function openRunLog(
  c: Caller,
  cache: FileCache,
  input: { computerId: string; runId: string; online: boolean },
  signal?: AbortSignal,
): Promise<{ log: RunLog; stale: boolean }> {
  const stored = await cachedLog(cache, input.computerId, input.runId);
  if (!input.online) {
    if (!stored) throw new Error("offline");
    return { log: stored, stale: true };
  }
  const first = await page(c, input.runId, 0, signal);
  signal?.throwIfAborted();
  if (stored && stored.totalBytes === first.totalBytes && stored.pages[0] === first.text)
    return { log: stored, stale: false };
  const log: RunLog = {
    pages: [first.text],
    nextOffset: first.nextOffset,
    totalBytes: first.totalBytes,
    truncated: first.truncated,
  };
  await store(cache, input.computerId, input.runId, log);
  return { log, stale: false };
}
/** Appends the next page (online only) and stores the longer copy. */
export async function moreRunLog(
  c: Caller,
  cache: FileCache,
  input: { computerId: string; runId: string; log: RunLog },
  signal?: AbortSignal,
): Promise<RunLog> {
  const offset = input.log.nextOffset;
  if (offset === null || input.log.pages.length >= MAX_LOG_PAGES) return input.log;
  const next = await page(c, input.runId, offset, signal);
  signal?.throwIfAborted();
  const log: RunLog = {
    pages: [...input.log.pages, next.text],
    nextOffset: next.nextOffset,
    totalBytes: next.totalBytes,
    truncated: next.truncated,
  };
  await store(cache, input.computerId, input.runId, log);
  return log;
}
/**
 * The owner's addition (2026-10-22): the first page of failed runs' logs is fetched ahead, so
 * the reason a run failed can be read offline. Bounded per pass; a run without a log is skipped.
 */
export async function prefetchFailedLogs(
  c: Caller,
  cache: FileCache,
  computerId: string,
  rows: readonly RecordRow[],
  danger: Parameters<typeof isFailed>[1],
  signal: AbortSignal,
) {
  let fetched = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    if (fetched >= RECORD_LIMITS.failedLogsPerPass) break;
    const runId = logRunId(row);
    if (!runId || seen.has(runId) || !isFailed(row, danger)) continue;
    seen.add(runId);
    signal.throwIfAborted();
    if (await cache.peek(computerId, logKey(runId))) continue;
    try {
      await openRunLog(c, cache, { computerId, runId, online: true }, signal);
      fetched++;
    } catch (error) {
      if (signal.aborted) throw error;
      // No log for that run (nothing was executed) or it was cleaned up. Remember that as an
      // empty log, or every records sync asks again (real phone 2026-11-12: one request every
      // ~1.5 s); opening the run still asks the computer once more.
      if (error instanceof RpcError && error.code === RpcErrorCodes.runLogMissing)
        await store(cache, computerId, runId, EMPTY_LOG);
    }
  }
  return fetched;
}
