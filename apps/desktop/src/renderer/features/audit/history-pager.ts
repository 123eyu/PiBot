import type { MethodParams, RoutineHistoryView } from "@pibot/protocol";
import { compareActivity } from "./activity.ts";
import { auditRead } from "./rpc.ts";

export type HistoryFetch = (
  query: MethodParams["routines.history"],
) => Promise<RoutineHistoryView[]>;
function checkScope(page: RoutineHistoryView[], botId?: string, from?: string, ids?: Set<string>) {
  if (
    page.some(
      (run) =>
        (botId && run.botId !== botId) ||
        (from && run.createdAt < from) ||
        (ids && !ids.has(run.id)),
    ) ||
    new Set(page.map((run) => run.id)).size !== page.length
  )
    throw new Error("Routine history scope mismatch");
}
export class RoutineHistoryPager {
  more = true;
  private cursor?: RoutineHistoryView;
  constructor(
    private readonly fetch: HistoryFetch,
    private readonly botId?: string,
    private readonly from?: string,
  ) {}
  reread(ids: string[], signal: AbortSignal) {
    return rereadRoutineHistory(this.fetch, ids, signal, this.botId, this.from);
  }
  async next(signal: AbortSignal) {
    if (!this.more) return [];
    const page = await auditRead(
      () => this.fetch({ limit: 200, botId: this.botId, from: this.from, before: this.cursor?.id }),
      signal,
    );
    signal.throwIfAborted();
    checkScope(page, this.botId, this.from);
    let previous = this.cursor;
    for (const run of page) {
      const current = { at: run.createdAt, id: run.id };
      if (previous && compareActivity({ at: previous.createdAt, id: previous.id }, current) >= 0)
        throw new Error("Routine history cursor did not advance");
      previous = run;
    }
    this.cursor = page.at(-1) ?? this.cursor;
    this.more = page.length === 200;
    return page;
  }
}
export async function rereadRoutineHistory(
  fetch: HistoryFetch,
  ids: string[],
  signal: AbortSignal,
  botId?: string,
  from?: string,
) {
  const updates: RoutineHistoryView[] = [];
  for (let index = 0; index < ids.length; index += 200) {
    signal.throwIfAborted();
    const batch = ids.slice(index, index + 200);
    const page = await auditRead(() => fetch({ ids: batch, limit: 200, botId, from }), signal);
    signal.throwIfAborted();
    checkScope(page, botId, from, new Set(batch));
    if (page.length !== batch.length) throw new Error("Routine history record unavailable");
    updates.push(...page);
  }
  return updates;
}
