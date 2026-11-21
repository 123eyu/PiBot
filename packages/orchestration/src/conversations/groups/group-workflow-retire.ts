import { type GroupTask, RpcError } from "@pibot/protocol-base";
import type { GroupWorkflowRunRecord, GroupWorkflowStepRecord } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

/** Inside replacement admission's transaction: retire only unfinished tasks of the old graph. */
export function retirePlanTasks(
  service: GroupService,
  previous: GroupWorkflowRunRecord,
  steps: readonly GroupWorkflowStepRecord[],
): GroupTask[] {
  const retired: GroupTask[] = [];
  const ids = new Set(
    steps.flatMap((step) =>
      step.status === "passed"
        ? []
        : [
            ...(step.taskId ? [step.taskId] : []),
            ...service.handoffs.repo.forWorkflowStep(previous.id, step.stepId),
          ],
    ),
  );
  for (const id of ids) {
    const task = service.tasks.get(id);
    if (task?.status !== "open") continue;
    // A blocked ledger entry alone does not prove that execution/continuations drained.
    if (service.runs.hasActiveForTask(task.id, ""))
      throw new RpcError(-32602, "group_plan_replacement_stale");
    retired.push(service.tasks.finish(task.id, task.assigneeBotId, "cancelled"));
    service.cycles.claimWake(task.id);
    service.deps.local.approvals.audit.append({
      botId: previous.coordinatorBotId,
      kind: "collaboration.completed",
      summary: "Replaced plan task cancelled / 被取代计划的任务已取消",
      detail: {
        actor: "system",
        groupId: previous.groupId,
        taskId: task.id,
        workflowRunId: previous.id,
        reasonCode: "plan_replaced",
      },
    });
  }
  return retired;
}
