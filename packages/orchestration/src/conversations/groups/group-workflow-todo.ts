import {
  ExecutionCollectionRepo,
  ExecutionRepo,
  type GroupWorkflowRunRecord,
  MessagesRepo,
  transaction,
} from "@pibot/storage";
import type { GroupService } from "./group-service.ts";
import { planReplacementChain } from "./group-workflow-lineage.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";

export function clearCompletedPlanPause(service: GroupService, record: GroupWorkflowRunRecord) {
  // The caller commits these updates with the plan's completion, then publishes after commit.
  return planReplacementChain(service, record).flatMap((item) => {
    const source = workflowOf(item).source;
    if (source.kind !== "dynamic") return [];
    return new MessagesRepo(service.deps.db)
      .clearPlanCheckpoint(source.originRunId, source.planId)
      .map((message) => ({ runId: source.originRunId, message }));
  });
}

/** Archive only the coordinator's frozen plan from this cycle, never a later edited TODO. */
export function archiveCompletedPlan(service: GroupService, record: GroupWorkflowRunRecord) {
  const group = service.groups.get(record.groupId);
  if (!group || service.cycles.get(group.id).cycleId !== record.cycleId) return;
  const scope = { botId: record.coordinatorBotId, conversationId: group.conversationId };
  const plan = new ExecutionRepo(service.deps.db).todo(scope);
  const source = plan.source ? service.runs.get(plan.source.runId) : undefined;
  if (
    !source ||
    source.botId !== scope.botId ||
    source.conversationId !== scope.conversationId ||
    source.groupId !== record.groupId ||
    source.cycleId !== record.cycleId ||
    !source.finishedAt ||
    !plan.updatedAt ||
    plan.updatedAt > source.finishedAt ||
    !["done", "error", "aborted"].includes(source.status) ||
    (!plan.items.length && !plan.goal)
  )
    return;
  const next = transaction(service.deps.db, () => {
    const value = new ExecutionCollectionRepo(service.deps.db).plan({
      ...scope,
      kind: "plan",
      action: "archive",
      expectedVersion: plan.version,
    });
    service.deps.local.approvals.audit.append({
      botId: scope.botId,
      kind: "execution.todo.changed",
      summary: "Completed group plan TODO archived",
      detail: {
        groupId: group.id,
        conversationId: scope.conversationId,
        workflowRunId: record.id,
        actor: "automatic",
        reasonCode: "plan_archive",
      },
    });
    return value;
  });
  return next;
}
