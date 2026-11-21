import type { CollaborationPort } from "@pibot/brain/orchestration-kit";
import { IdSchema, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { MessagesRepo, RunRecoveryRepo } from "@pibot/storage";
import { pendingPlanBudgetResume } from "./group-plan-budget-pending.ts";
import { assertPlanWorkplace } from "./group-plan-workplace.ts";
import type { GroupService } from "./group-service.ts";
import { progressOf } from "./group-workflow-progress.ts";

/** A cost stop may resume the actual step, never replay the plan or its passed predecessors. */
export function planBudgetResume(
  service: GroupService,
  runId: string,
): ReturnType<NonNullable<CollaborationPort["planBudgetResume"]>> {
  const run = service.runs.get(runId);
  if (
    !run?.groupId ||
    !run.cycleId ||
    !(run.status === "aborted" || (run.status === "error" && run.errorCode === "budget_exhausted"))
  )
    return;
  const rootId = service.deps.local.tasks.budgetRoot(run);
  const root = service.runs.get(rootId);
  const message = root?.userMessageId
    ? new MessagesRepo(service.deps.db).get(root.userMessageId)
    : undefined;
  if (
    message?.role !== "user" ||
    message.conversationId !== root?.conversationId ||
    root?.groupId !== run.groupId ||
    root.cycleId !== run.cycleId
  )
    return;
  if (run.id === rootId) {
    const pending = pendingPlanBudgetResume(service, run);
    if (pending) return pending;
  }
  const { repo } = service.workflows;
  const record = repo.latestPlan(run.groupId, run.cycleId, rootId);
  if (record && repo.workplaceRevoked(record.id)) return;
  if (record && run.id === rootId) {
    const rootReply = new MessagesRepo(service.deps.db).get(run.messageId);
    const usage = rootReply?.usage;
    const prior = IdSchema.safeParse(
      usage && typeof usage === "object" && !Array.isArray(usage)
        ? usage.groupPlanBudgetResume
        : undefined,
    );
    const resumed = prior.success ? service.runs.get(prior.data) : undefined;
    const recovery = resumed ? new RunRecoveryRepo(service.deps.db).get(resumed.id) : undefined;
    if (
      resumed?.groupId === record.groupId &&
      recovery?.rootRunId === rootId &&
      recovery.resumedFrom &&
      resumed.triggerKey?.startsWith("group-task-resume:")
    )
      return { resumedRunId: resumed.id, assertCurrent() {}, inserted() {} };
    const candidates = repo
      .steps(record.id)
      .filter((item) => item.executionRunId && ["running", "blocked"].includes(item.status));
    const executions = candidates.flatMap((candidate) => {
      const execution = service.runs.get(candidate.executionRunId as string);
      return execution ? [execution] : [];
    });
    const started = executions.filter((execution) => execution.startedAt !== null);
    // Queued cancellations have no side effects; several actually started steps need disposition.
    if (started.length > 1) return;
    const child = started[0] ?? executions[0];
    const ticket = child ? planBudgetResume(service, child.id) : undefined;
    if (!child || !ticket || child.id === run.id) return;
    return {
      ...ticket,
      redirect: { botId: child.botId, conversationId: child.conversationId, runId: child.id },
    };
  }
  if (!run.taskId) return;
  const step = repo.byTask(run.taskId);
  if (
    !record ||
    !step ||
    step.workflowRunId !== record.id ||
    step.executionRunId !== run.id ||
    step.ownerBotId !== run.botId ||
    !["running", "blocked"].includes(step.status) ||
    !["running", "waiting", "failed"].includes(record.status)
  )
    return;
  // An unknown tool effect needs explicit verification rather than an automatic replay.
  if (
    service.deps.local.toolJournal.repo.uncertainCount(run.id) ||
    service.handoffs.repo.get(run.taskId)?.result
  )
    return;
  const stopped = progressOf(record).stoppedReason;
  if (stopped && stopped !== "cost") return;
  const ledger = service.deps.local.budgets.repo.get(rootId);
  if (ledger?.exhaustedReason !== "cost") return;
  const assertCurrent = () => {
    const current = repo.get(record.id);
    const actual = repo.byTask(run.taskId as string);
    const group = service.active(record.groupId, run.botId, run.conversationId);
    if (
      !current ||
      current.updatedAt !== record.updatedAt ||
      actual?.executionRunId !== run.id ||
      actual.status !== step.status ||
      group.paused ||
      service.cycles.get(group.id).cycleId !== record.cycleId ||
      service.deps.local.budgets.repo.get(rootId)?.exhaustedReason !== "cost"
    )
      throw new RpcError(RpcErrorCodes.busy, "group_plan_budget_resume_stale");
    assertPlanWorkplace(service, record.id);
    const owned = new Set([
      rootId,
      ...repo
        .steps(record.id)
        .flatMap((item) => (item.executionRunId ? [item.executionRunId] : [])),
    ]);
    if (service.deps.chat.queue.resources().contexts.some((context) => owned.has(context.runId)))
      throw new RpcError(RpcErrorCodes.busy, "group_plan_budget_resume_draining");
  };
  return {
    assertCurrent,
    inserted(newRunId: string) {
      // The resume/raise transaction already rechecked the ticket, task identity and current policy.
      repo.updateStep(record.id, step.stepId, { status: "running", executionRunId: newRunId });
      service.handoffs.repo.setState(run.taskId as string, "pending");
      repo.updateRun(record.id, "running");
      service.workflows.progress.save(record, {
        ...progressOf(record),
        stoppedReason: undefined,
        requested: false,
      });
      for (const sibling of repo.steps(record.id)) {
        if (
          sibling.stepId === step.stepId ||
          sibling.status !== "blocked" ||
          !sibling.taskId ||
          !sibling.executionRunId ||
          sibling.decisionMessageId
        )
          continue;
        const cancelled = service.runs.get(sibling.executionRunId);
        const task = service.tasks.get(sibling.taskId);
        if (
          cancelled?.status !== "aborted" ||
          cancelled.startedAt !== null ||
          task?.status !== "open" ||
          service.handoffs.repo.get(task.id)?.result
        )
          continue;
        // Only never-started siblings are re-admitted. Started work needs its own journal resume.
        service.tasks.finish(task.id, task.assigneeBotId, "cancelled");
        service.cycles.claimWake(task.id);
        repo.updateStep(record.id, sibling.stepId, {
          status: "ready",
          taskId: null,
          executionRunId: null,
        });
        service.deps.local.approvals.audit.append({
          botId: record.coordinatorBotId,
          kind: "collaboration.completed",
          summary: "Unstarted budget-stopped step re-admitted / 预算停止的未启动步骤重新登记",
          detail: {
            actor: "system",
            groupId: record.groupId,
            taskId: task.id,
            workflowRunId: record.id,
            reasonCode: "budget_resume_unstarted",
          },
        });
      }
      if (root?.status === "error" && root.errorCode === "budget_exhausted") {
        const messages = new MessagesRepo(service.deps.db);
        const reply = messages.get(root.messageId);
        const usage = reply?.usage;
        if (reply)
          messages.update(reply.id, {
            usage: {
              ...(usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {}),
              groupPlanBudgetResume: newRunId,
            },
          });
      }
    },
  };
}
