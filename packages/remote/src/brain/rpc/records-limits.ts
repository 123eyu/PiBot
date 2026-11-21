import type { MethodResults } from "@pibot/protocol";

/**
 * The phone reads the computer's run records for the last 3 days only.
 * The bound is applied here, on the computer's clock, so a phone with a wrong clock or an old
 * build still cannot page further back; requests also get capped page sizes.
 */
export const RECORD_WINDOW_MS = 3 * 86_400_000;
/**
 * One runs.readLog page for the phone. A log is UTF-8 and may be full of control characters
 * (ANSI colour codes), which JSON escapes as six bytes each: 128 KiB × 6 = 786,432 bytes plus the
 * envelope stays under the 900 kB phone frame, so every page fits without a separate slicer.
 */
export const PHONE_LOG_PAGE = 128 * 1024;
const PAGE_CAPS: Partial<Record<string, number>> = {
  "audit.list": 100,
  "backgroundCommands.page": 50,
  "routines.history": 100,
  "chat.runs": 100,
};
const recordMethods = new Set([...Object.keys(PAGE_CAPS), "runs.readLog"]);
export const isRecordMethod = (method: string) => recordMethods.has(method);
const cutoffOf = (now: number) => new Date(now - RECORD_WINDOW_MS).toISOString();
const recent = (at: string | null | undefined, cutoff: number) => !!at && Date.parse(at) >= cutoff;

/** Params as dispatched: page sizes capped, the history lower bound moved up to the window. */
export function clampRecordParams(method: string, params: unknown, now: number): unknown {
  if (!isRecordMethod(method) || !params || typeof params !== "object") return params;
  const input = { ...(params as Record<string, unknown>) };
  const cap = method === "runs.readLog" ? PHONE_LOG_PAGE : PAGE_CAPS[method];
  if (cap !== undefined)
    input.limit = typeof input.limit === "number" ? Math.min(input.limit, cap) : cap;
  if (method === "routines.history") {
    const cutoff = cutoffOf(now);
    if (typeof input.from !== "string" || Date.parse(input.from) < Date.parse(cutoff))
      input.from = cutoff;
  }
  return input;
}

/**
 * Results as returned to the phone: rows older than the window are dropped (newest-first pages,
 * so a short page tells the phone it reached the bound). Runs still in progress stay: they are
 * current activity, whenever they began.
 */
export function clampRecordResult(method: string, result: unknown, now: number): unknown {
  if (!Array.isArray(result)) return result;
  const cutoff = now - RECORD_WINDOW_MS;
  switch (method) {
    case "audit.list":
      return (result as MethodResults["audit.list"]).filter((row) => recent(row.at, cutoff));
    case "routines.history":
      return (result as MethodResults["routines.history"]).filter((run) =>
        recent(run.createdAt, cutoff),
      );
    case "chat.runs":
      return (result as MethodResults["chat.runs"]).filter(
        (run) =>
          recent(run.createdAt, cutoff) || ["queued", "running", "waiting"].includes(run.status),
      );
    case "backgroundCommands.page":
      return (result as MethodResults["backgroundCommands.page"]).filter(
        (row) => row.status === "running" || recent(row.endedAt ?? row.startedAt, cutoff),
      );
    default:
      return result;
  }
}
