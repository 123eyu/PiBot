import type { DatabaseSync } from "node:sqlite";
import type { BrainRedactor, LocalService, RunQueue } from "@pibot/brain/kit";
import type { RoutineRun } from "@pibot/protocol";
import { ApprovalsRepo, AuditRepo, MessagesRepo, RunsRepo, transaction } from "@pibot/storage";
import { RoutineRunsRepo } from "../../store/index.ts";

export async function cancelRoutineExecution(
  record: RoutineRun,
  deps: {
    db: DatabaseSync;
    queue: RunQueue;
    local: LocalService;
    redactor: BrainRedactor;
    finish(): void;
    changed(run: RoutineRun): void;
  },
) {
  const approvals = new ApprovalsRepo(deps.db),
    runs = new RoutineRunsRepo(deps.db);
  const pending = record.waitCheckpoint
    ? approvals.get(record.waitCheckpoint.approvalId)
    : undefined;
  if (record.runId) await deps.queue.abort(record.runId);
  const cancelled = transaction(deps.db, () => {
    deps.finish();
    const current = runs.require(record.id);
    if (current.status !== "cancelled") return false;
    if (record.runId) {
      const execution = new RunsRepo(deps.db).get(record.runId);
      if (execution)
        new MessagesRepo(deps.db).update(execution.messageId, {
          status: "aborted",
          errorCode: "aborted",
        });
    }
    const audit = new AuditRepo(deps.db, deps.redactor);
    audit.append({
      botId: record.botId,
      runId: record.runId,
      kind: "routine.run.cancelled",
      summary: "例行运行已停止 / Routine run stopped",
      detail: {
        routineRunId: record.id,
        ...(record.routineId ? { routineId: record.routineId } : {}),
        actor: "user",
        reasonCode: "cancelled",
        source: record.reason === "trial" ? "trial" : "routine",
      },
    });
    // Live gates already audit their own abort. Detached gates have no waiter to emit that fact.
    if (
      pending?.status === "pending" &&
      record.waitCheckpoint?.drain &&
      approvals.get(pending.id)?.status === "cancelled"
    ) {
      audit.append({
        botId: record.botId,
        runId: record.runId,
        kind: "approval.resolved",
        summary: "例行审批已撤销 / Routine approval cancelled",
        detail: {
          approvalId: pending.id,
          routineRunId: record.id,
          toolCallId: pending.toolCallId,
          category: pending.category,
          actor: "user",
          status: "cancelled",
          remember: false,
          source: record.reason === "trial" ? "trial" : "routine",
        },
      });
      deps.local.deps.peer.emit("approval.resolved", {
        id: pending.id,
        status: "cancelled",
        remembered: false,
      });
    }
    deps.changed(current);
    return true;
  });
  if (cancelled && record.runId) {
    const execution = new RunsRepo(deps.db).get(record.runId);
    if (execution) {
      deps.local.deps.peer.emit("chat.error", {
        botId: record.botId,
        conversationId: execution.conversationId,
        runId: execution.id,
        messageId: execution.messageId,
        code: "aborted",
        message: "Run cancelled",
      });
      // The queue emits the idle transition when the run really leaves it.
    }
  }
  deps.queue.resume();
}
