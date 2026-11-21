import type { ToolRunContext } from "@pibot/brain/orchestration-kit";
import { RpcError } from "@pibot/protocol-base";
import type { GroupWorkflowRunRecord } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";
import { logicalWebTask } from "./group-web-task.ts";
import { planReplacementChain } from "./group-workflow-lineage.ts";

/** Model-supplied task IDs never select authority; only persisted live membership does. */
export function publicWebTaskScope(service: GroupService, context: ToolRunContext) {
  if (context.routineRunId || context.routineSource || !context.groupId) return;
  const run = service.runs.get(context.runId);
  const group = service.groups.get(context.groupId);
  if (
    !run ||
    !group ||
    group.topicArchivedAt ||
    group.paused ||
    run.status !== "running" ||
    run.botId !== context.botId ||
    run.groupId !== group.id ||
    run.conversationId !== context.conversationId ||
    run.messageId !== context.messageId ||
    !run.cycleId ||
    service.cycles.get(group.id).cycleId !== run.cycleId ||
    !group.members.some((member) => member.botId === run.botId)
  )
    return;
  if (!run.taskId) {
    if (run.botId !== group.coordinatorBotId || run.conversationId !== group.conversationId) return;
    const card = service.plans.repo.forCycle(group.conversationId, run.cycleId)?.card;
    const plan = card ? service.workflows.repo.byPlan(card.id) : undefined;
    return plan &&
      ["running", "waiting"].includes(plan.status) &&
      plan.groupId === group.id &&
      plan.cycleId === run.cycleId
      ? planWebScope(service, plan)
      : undefined;
  }
  if (run.kind !== "group_task" && run.kind !== "wake") return;
  const task = service.tasks.get(run.taskId);
  if (
    task?.status !== "open" ||
    task.groupId !== group.id ||
    task.assigneeBotId !== run.botId ||
    task.threadConversationId !== run.conversationId ||
    task.createdByBotId !== group.coordinatorBotId
  )
    return;
  const ref = service.handoffs.repo.get(task.id)?.spec.workflowStep;
  if (!ref) {
    const root = logicalWebTask(service, task, run.cycleId);
    return root ? `task:${root}` : undefined;
  }
  const plan = service.workflows.repo.get(ref.workflowRunId);
  const step =
    plan && service.workflows.repo.steps(plan.id).find((item) => item.stepId === ref.stepId);
  const anchor = step?.executionRunId ? service.runs.get(step.executionRunId) : undefined;
  if (
    !plan ||
    !["running", "waiting"].includes(plan.status) ||
    plan.groupId !== group.id ||
    plan.cycleId !== run.cycleId ||
    plan.coordinatorBotId !== group.coordinatorBotId ||
    step?.taskId !== task.id ||
    step.ownerBotId !== run.botId ||
    anchor?.taskId !== task.id ||
    anchor.botId !== run.botId ||
    anchor.conversationId !== run.conversationId
  )
    return;
  return planWebScope(service, plan);
}

/** Only the accepted, bidirectionally linked replacements share the original temporary consent. */
export function planWebScope(service: GroupService, plan: GroupWorkflowRunRecord) {
  try {
    const root = planReplacementChain(service, plan).at(-1);
    return root ? `plan:${root.id}` : undefined;
  } catch (error) {
    if (error instanceof RpcError) return undefined;
    throw error;
  }
}

/** Shared terminal cleanup; accepted replacement keeps the logical task alive. */
export function settlePlanWebConsent(service: GroupService, record: GroupWorkflowRunRecord) {
  const current = service.workflows.repo.get(record.id);
  if (!current || ["running", "waiting"].includes(current.status)) return;
  const scope = planWebScope(service, current);
  if (current.status === "cancelled" && current.budgetRootRunId) {
    const latest = service.workflows.repo.latestPlan(
      current.groupId,
      current.cycleId,
      current.budgetRootRunId,
    );
    if (
      latest &&
      ["running", "waiting"].includes(latest.status) &&
      planWebScope(service, latest) === scope &&
      scope
    )
      return;
  }
  service.deps.local.approvals.revokeTaskWeb(scope ?? `plan:${current.id}`);
}
