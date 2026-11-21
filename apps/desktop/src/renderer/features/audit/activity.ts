import type { AuditEntry, RoutineHistoryView } from "@pibot/protocol";

export type ActivityEntry =
  | { type: "audit"; id: string; at: string; botId: string; entry: AuditEntry }
  | { type: "routine-run"; id: string; at: string; botId: string; run: RoutineHistoryView };
export function auditActivity(entry: AuditEntry): ActivityEntry {
  return { type: "audit", id: `audit:${entry.id}`, at: entry.at, botId: entry.botId, entry };
}
export function runActivity(run: RoutineHistoryView): ActivityEntry {
  return {
    type: "routine-run",
    id: `routine-run:${run.id}`,
    at: run.createdAt,
    botId: run.botId,
    run,
  };
}
export function compareActivity(a: { at: string; id: string }, b: { at: string; id: string }) {
  return b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
}
export function mergeActivity(previous: ActivityEntry[], updates: ActivityEntry[]) {
  // Runs mutate in place; ID deduplication must replace their old status and metadata.
  return [...new Map([...previous, ...updates].map((entry) => [entry.id, entry])).values()].sort(
    compareActivity,
  );
}
