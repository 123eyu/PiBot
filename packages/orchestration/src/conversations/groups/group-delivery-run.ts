// A member corrects its persisted handoff contract inside the original run before any send-back.
import { DeliveryRun, type ToolRunContext, type WorkflowRun } from "@pibot/brain/orchestration-kit";
import { RpcError } from "@pibot/protocol-base";
import type { GroupHandoffCheckCache } from "./group-handoff-cache.ts";
import { prepareHandoffCheck } from "./group-handoff-context.ts";
import type { GroupService } from "./group-service.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";

export function groupDeliveryRun(
  service: GroupService,
  context: ToolRunContext,
  workflow: WorkflowRun | undefined,
  checks: GroupHandoffCheckCache,
) {
  const run = service.runs.get(context.runId);
  const task = run?.taskId ? service.tasks.get(run.taskId) : undefined;
  const record = task ? service.handoffs.repo.get(task.id) : undefined;
  if (
    !run ||
    !task ||
    !record ||
    run.groupId !== task.groupId ||
    run.botId !== task.assigneeBotId ||
    context.groupId !== task.groupId
  )
    return;
  const step = record.spec.workflowStep;
  const plan = step ? service.workflows.repo.get(step.workflowRunId) : undefined;
  const definition = plan
    ? workflowOf(plan).contract.steps?.find((s) => s.id === step?.stepId)
    : undefined;
  // The step's own limit, else the plan's (an explicit 0 means no in-run correction either), else
  // the member's workflow; one round only when nothing says otherwise.
  const maxFixRounds =
    definition?.maxFixRounds ??
    (plan ? workflowOf(plan).contract.maxFixRounds : undefined) ??
    workflow?.contract.maxFixRounds ??
    1;
  return new DeliveryRun({
    workflow: {
      name: (record.spec.workflow?.name ?? "群任务交付 / Group task delivery").slice(0, 80),
      version: record.spec.workflow?.version ?? null,
      contract: {
        inputs: [],
        prechecks: [],
        stop: [],
        approvals: [],
        deliverables: record.spec.deliverables,
        acceptance: record.spec.acceptance,
        // In-run correction belongs to a step's first attempt only: a resubmission after a
        // send-back already spends the handoff's fix rounds, so rounds do not multiply.
        maxFixRounds: record.returnOf ? 0 : maxFixRounds,
      },
    },
    folder: record.baseFolder ?? context.runWorkplace?.cwd ?? "",
    check: memberCheck(service, context, task.id, record.baseFolder ?? "", checks),
    sources: () => ({ webDigests: new Set<string>(), files: [], folders: [] }),
    office: () => service.deps.local.officeProvider,
    language: context.language,
    signal: context.signal,
    logger: service.deps.logger,
    runId: run.id,
    botId: run.botId,
  });
}

function memberCheck(
  service: GroupService,
  context: ToolRunContext,
  taskId: string,
  folder: string,
  checks: GroupHandoffCheckCache,
) {
  return async (signal: AbortSignal) => {
    try {
      return await checkNow(signal);
    } catch (error) {
      // The run's own stop still ends the run. Anything else (the handoff moved on, the workplace
      // changed, the check timed out) only skips the in-run correction: the final handoff check
      // decides as it did before the in-run check, instead of the member's run ending in an error.
      if (context.signal.aborted) throw error;
      service.deps.logger.warn(
        JSON.stringify({
          module: "group",
          event: "in_run_check_skipped",
          runId: context.runId,
          taskId,
          code:
            error instanceof RpcError && /^[a-z_]{1,80}$/u.test(error.message)
              ? error.message
              : signal.aborted
                ? "check_timeout"
                : "check_failed",
        }),
      );
      return { items: [], folder };
    }
  };
  async function checkNow(signal: AbortSignal) {
    service.deps.local.tasks.guardSync(context);
    if (
      context.todoRun?.paused ||
      service.deps.local.tasks.hasPendingChildren(context) ||
      service.deps.local.background.waitingRun(context.runId) ||
      service.deps.local.approvals.repo.blocksTaskCompletion(context.runId)
    )
      return { items: [], folder };
    const task = service.tasks.get(taskId);
    const current = service.handoffs.repo.get(taskId);
    if (!task || current?.state !== "pending")
      throw new RpcError(-32602, "group_plan_replacement_stale");
    const prepared = await prepareHandoffCheck(service, task, current, context.runId, signal);
    return {
      items: await checks.check(context.runId, prepared, signal),
      folder: prepared.record.baseFolder ?? "",
    };
  }
}
