import type { LocalToolCall } from "@pibot/agent";
import type { AuditKind } from "@pibot/protocol-base";
import { type ToolJournalEntry, type ToolJournalRepo, transaction } from "@pibot/storage";
import type { ToolRunContext } from "../../../core/local-types.ts";
import type { LocalService } from "../../../local-service.ts";

/**
 * Audit of one journal transition (kinds `tool.journal.*`, see protocol-base audit.ts): tool
 * name, call id, effect class, attempt and a `journal_*` reason code. Never arguments or results.
 */
export function journalAudit(
  local: LocalService,
  context: ToolRunContext,
  call: LocalToolCall,
  entry: ToolJournalEntry,
  kind: AuditKind,
  reasonCode: string,
) {
  local.approvals.audit.append({
    botId: context.botId,
    runId: context.runId,
    kind,
    summary: `Tool journal: ${reasonCode} / 执行登记`,
    detail: {
      toolName: call.tool,
      toolCallId: call.id,
      effectClass: entry.effectClass,
      attempt: Math.min(entry.attempts, 1000),
      reasonCode,
      source: context.routineSource ?? context.auditSource ?? "chat",
      ...(context.routineRunId ? { routineRunId: context.routineRunId } : {}),
    },
  });
}

/** Startup: a previous process's in-flight calls have unknown outcomes (one audit per Bot). */
export function recoverJournal(local: LocalService, repo: ToolJournalRepo) {
  const left = transaction(local.deps.db, () => {
    const rows = repo.recover();
    const byBot = new Map<string, number>();
    for (const row of rows) byBot.set(row.botId, (byBot.get(row.botId) ?? 0) + 1);
    for (const [botId, count] of byBot)
      local.approvals.audit.append({
        botId,
        kind: "tool.journal.unknown",
        summary: "Tool journal: calls left in flight by a restart / 重启时未结束的调用",
        detail: { reasonCode: "journal_recovered", entryCount: count },
      });
    return rows.length;
  });
  if (left)
    local.deps.logger.warn(
      JSON.stringify({ module: "tool-journal", event: "recovered", count: left }),
    );
}
