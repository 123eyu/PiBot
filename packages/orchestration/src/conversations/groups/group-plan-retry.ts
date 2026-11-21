import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { MessagesRepo, RunRecoveryRepo } from "@pibot/storage";
import { assertPlanWorkplace } from "./group-plan-workplace.ts";
import type { GroupService } from "./group-service.ts";
import { decisionText } from "./group-workflow-decision-text.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { decisionOf, workflowOf } from "./group-workflow-snapshot.ts";

/** Trusted queue configuration: retries spend from the same whole-plan ledger as dispatch. */
export function planStepRetryInput(service: GroupService, failedRunId: string) {
  const failed = service.runs.get(failedRunId);
  if (!failed?.taskId) return undefined;
  const step = service.workflows.repo.byTask(failed.taskId);
  if (!step) return undefined;
  const plan = service.workflows.repo.get(step.workflowRunId);
  if (
    !plan?.budgetRootRunId ||
    service.deps.local.tasks.budgetRoot(failed) !== plan.budgetRootRunId
  )
    throw new RpcError(-32602, "group_plan_retry_budget_changed");
  return {
    budgetRootRunId: plan.budgetRootRunId,
    budgetWorkflow: { contract: workflowOf(plan).contract },
    enforceBudgetCost: true,
  };
}

/** Called inside the user's existing retry transaction, before the queue publishes the run. */
export function planStepRetried(service: GroupService, failedRunId: string, newRunId: string) {
  const failed = service.runs.get(failedRunId),
    next = service.runs.get(newRunId);
  if (!failed?.taskId || !next) return;
  const repo = service.workflows.repo,
    step = repo.byTask(failed.taskId);
  if (!step) return;
  const plan = repo.get(step.workflowRunId);
  if (!plan || plan.status === "cancelled" || plan.status === "passed")
    throw new RpcError(-32602, "group_plan_retry_stale");
  if (
    !plan.budgetRootRunId ||
    service.deps.local.tasks.budgetRoot(failed) !== plan.budgetRootRunId ||
    new RunRecoveryRepo(service.deps.db).root(next.id) !== plan.budgetRootRunId
  )
    throw new RpcError(-32602, "group_plan_retry_budget_changed");
  if (step.executionRunId === newRunId) return;
  if (service.handoffs.repo.get(failed.taskId)?.result)
    throw new RpcError(-32602, "group_plan_retry_stale");
  const progress = progressOf(plan);
  if (
    progress.requested ||
    (progress.stoppedReason &&
      !["cost", "model_requests", "active_seconds"].includes(progress.stoppedReason))
  )
    throw new RpcError(-32602, "group_plan_retry_stale");
  if (
    step.executionRunId !== failedRunId ||
    !["running", "blocked"].includes(step.status) ||
    next.taskId !== failed.taskId ||
    next.groupId !== plan.groupId ||
    next.botId !== step.ownerBotId ||
    next.conversationId !== failed.conversationId ||
    next.cycleId !== plan.cycleId ||
    service.cycles.get(plan.groupId).cycleId !== plan.cycleId
  )
    throw new RpcError(-32602, "group_plan_retry_stale");
  const limit = service.workflows.progress.hardLimit(plan, true);
  if (limit) throw new RpcError(RpcErrorCodes.busy, "group_plan_retry_budget_required");
  assertPlanWorkplace(service, plan.id);
  if (step.decisionMessageId) {
    const messages = new MessagesRepo(service.deps.db),
      message = messages.get(step.decisionMessageId);
    const decision = decisionOf(message?.usage);
    if (
      message &&
      decision?.state === "pending" &&
      decision.workflowRunId === plan.id &&
      decision.stepId === step.stepId
    ) {
      const resolved = { ...decision, state: "resolved" as const, resolution: "retry" as const };
      messages.update(message.id, {
        content: decisionText(resolved, service.deps.chat.currentLanguage()),
        usage: { ...(message.usage as Record<string, unknown>), groupWorkflowDecision: resolved },
      });
    }
  }
  repo.updateStep(plan.id, step.stepId, {
    status: "running",
    executionRunId: next.id,
    decisionMessageId: null,
  });
  service.handoffs.repo.setState(failed.taskId, "pending");
  repo.updateRun(plan.id, "running");
  service.workflows.progress.save(plan, {
    ...progress,
    requested: false,
    stoppedReason: undefined,
  });
  service.deps.local.approvals.audit.append({
    botId: next.botId,
    runId: next.id,
    kind: "execution.todo.changed",
    summary: "Plan step resumed / 计划步骤已接续",
    detail: {
      groupId: plan.groupId,
      workflowRunId: plan.id,
      taskId: failed.taskId,
      childRunId: next.id,
      actor: "user",
      reasonCode: "step_retry",
    },
  });
}
