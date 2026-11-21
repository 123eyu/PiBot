import { isInternalAudit } from "@pibot/client-core";
import {
  type AuditEntry,
  AuditEntrySchema,
  type BackgroundCommandRecord,
  BackgroundCommandRecordSchema,
  type MethodResults,
  Methods,
  type RoutineHistoryView,
  RoutineHistoryViewSchema,
} from "@pibot/protocol";
import { z } from "zod";

/**
 * The phone keeps the computer's run records of the last 3 days (the desktop gateway
 * enforces the same bound on its clock; this one only trims the phone's own copy).
 */
export const RECORD_WINDOW_MS = 3 * 86_400_000;
export const recordCutoff = (now = Date.now()) => now - RECORD_WINDOW_MS;

export type ChatRun = MethodResults["chat.runs"][number];
/** One line of the phone's 记录 page, from one of the desktop's four record sources. */
export type RecordRow =
  | { type: "audit"; id: string; at: string; botId: string; entry: AuditEntry }
  | { type: "routine"; id: string; at: string; botId: string; run: RoutineHistoryView }
  | { type: "chat"; id: string; at: string; botId: string; run: ChatRun }
  | { type: "command"; id: string; at: string; botId: string; command: BackgroundCommandRecord };

export const auditRow = (entry: AuditEntry): RecordRow => ({
  type: "audit",
  id: `audit:${entry.id}`,
  at: entry.at,
  botId: entry.botId,
  entry,
});
export const routineRow = (run: RoutineHistoryView): RecordRow => ({
  type: "routine",
  id: `routine:${run.id}`,
  at: run.createdAt,
  botId: run.botId,
  run,
});
export const chatRow = (run: ChatRun): RecordRow => ({
  type: "chat",
  id: `chat:${run.id}`,
  at: run.createdAt,
  botId: run.botId,
  run,
});
export const commandRow = (command: BackgroundCommandRecord): RecordRow => ({
  type: "command",
  id: `command:${command.id}`,
  // Ended ones sort by when they ended, as on the desktop's background tab.
  at: command.endedAt ?? command.startedAt,
  botId: command.botId,
  command,
});

/**
 * The cached copy, one storage value per source: each stays under the local database's
 * per-value limit on its own, and a source can be refreshed without rewriting the others.
 * `truncated` marks a source that had more rows in the window than the phone keeps.
 */
const sourceSchema = <T extends z.ZodType>(row: T) =>
  z.object({ rows: z.array(row).max(1000), truncated: z.boolean(), syncedAt: z.number() });
export const RecordSources = {
  audit: sourceSchema(AuditEntrySchema),
  routines: sourceSchema(RoutineHistoryViewSchema),
  chats: sourceSchema(Methods["chat.runs"].result.element),
  commands: sourceSchema(BackgroundCommandRecordSchema),
} as const;
export type RecordSource = keyof typeof RecordSources;
export type SourceCopy<K extends RecordSource> = z.infer<(typeof RecordSources)[K]>;
export const recordKey = (computerId: string, source: RecordSource) =>
  `cache:${computerId}:records:${source}`;
/** Per source: rows kept on the phone (newest first) and the request page size. */
export const RECORD_LIMITS = {
  audit: 600,
  routines: 200,
  chats: 300,
  commands: 100,
  auditPage: 100,
  auditPages: 6,
  routinePage: 100,
  commandPage: 50,
  runSources: 20,
  runPage: 20,
  // LocalData refuses a value over 1,000,000 characters.
  valueChars: 900_000,
  failedLogsPerPass: 5,
} as const;

export const recordFilters = ["all", "chat", "routine", "command", "connector", "failed"] as const;
export type RecordFilter = (typeof recordFilters)[number];
export type RecordScope = { kind: "bot" | "group"; id: string } | undefined;

const ACTIVE_RUN = new Set(["queued", "running", "waiting"]);
/** Whether a row ended in failure: the 失败 filter and the red outcome. */
export function isFailed(row: RecordRow, danger: (entry: AuditEntry) => boolean): boolean {
  switch (row.type) {
    case "audit":
      return danger(row.entry);
    case "routine":
      return row.run.status === "failed" || row.run.status === "timeout";
    case "chat":
      return row.run.status === "error";
    case "command":
      return (
        row.command.status === "failed" ||
        (row.command.status === "exited" && !!row.command.exitCode)
      );
  }
}
export function isRunning(row: RecordRow): boolean {
  if (row.type === "chat") return ACTIVE_RUN.has(row.run.status);
  if (row.type === "routine") return ["scheduled", "running", "waiting"].includes(row.run.status);
  if (row.type === "command") return row.command.status === "running";
  return row.entry.kind === "exec.started" || row.entry.kind === "approval.requested";
}
function category(row: RecordRow, group: (entry: AuditEntry) => string) {
  if (row.type === "chat") return "chat";
  if (row.type === "routine") return "routine";
  if (row.type === "command") return "command";
  const kind = group(row.entry);
  if (kind === "scheduling") return "routine";
  if (row.entry.kind.startsWith("exec.")) return "command";
  if (kind === "connectors") return "connector";
  return "other";
}
/** Group ownership of a run, from the cached chat runs and background commands. */
export function runGroups(rows: readonly RecordRow[]) {
  const groups = new Map<string, string>();
  for (const row of rows) {
    if (row.type === "chat" && row.run.groupId) groups.set(row.run.id, row.run.groupId);
    if (row.type === "command" && row.command.groupId)
      groups.set(row.command.runId, row.command.groupId);
  }
  return groups;
}
function inScope(row: RecordRow, scope: RecordScope, groups: Map<string, string>) {
  if (!scope) return true;
  if (scope.kind === "bot") return row.botId === scope.id;
  switch (row.type) {
    case "chat":
      return row.run.groupId === scope.id;
    case "command":
      return row.command.groupId === scope.id;
    case "audit":
      return !!row.entry.runId && groups.get(row.entry.runId) === scope.id;
    case "routine":
      return false;
  }
}
/**
 * The page's filters, the same six as the desktop owner asked for. Internal bookkeeping
 * audits stay hidden as on the desktop's default view.
 */
export function filterRecords(
  rows: readonly RecordRow[],
  filter: RecordFilter,
  scope: RecordScope,
  present: { group(entry: AuditEntry): string; danger(entry: AuditEntry): boolean },
) {
  const groups = runGroups(rows);
  return rows.filter((row) => {
    if (row.type === "audit" && isInternalAudit(row.entry)) return false;
    if (!inScope(row, scope, groups)) return false;
    if (filter === "all") return true;
    if (filter === "failed") return isFailed(row, present.danger);
    return category(row, present.group) === filter;
  });
}
export function compareRecords(a: RecordRow, b: RecordRow) {
  return b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
}
/** The run whose execution log a row can open (the desktop's 执行日志 / 完整输出). */
export function logRunId(row: RecordRow): string | undefined {
  if (row.type === "audit")
    return row.entry.kind === "exec.finished" && typeof row.entry.detail.exitCode === "number"
      ? (row.entry.runId ?? undefined)
      : undefined;
  if (row.type === "routine") return row.run.runId ?? undefined;
  if (row.type === "chat") return row.run.id;
  return undefined;
}
