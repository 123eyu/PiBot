import type { ToolRunContext } from "@pibot/brain/orchestration-kit";
import type { GroupExecutionReceipt } from "@pibot/protocol-base";
import { MessagesRepo } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";
import { completedReplacement } from "./group-workflow-lineage.ts";

/** A reply snapshot must not turn a planning turn or a member's delivery into a final claim. */
export function groupExecutionReceipt(
  service: GroupService,
  context: ToolRunContext,
): GroupExecutionReceipt | undefined {
  const held = service.planAttempts?.state(context);
  if (
    held &&
    context.groupId &&
    context.conversationId &&
    ["waiting", "ended", "solo"].includes(held.status)
  ) {
    const facts = service.workflows.repo.executionSummary(
      context.groupId,
      context.conversationId,
      held.cycleId,
    );
    if (!facts.plans && !facts.delegated) {
      if (held.status !== "solo") return { kind: "solo", completed: false };
      if (!context.todoRun?.paused) return { kind: "solo" };
    }
  }

  // A normal model stop can still be waiting for a decision, blocked, or at a checkpoint.
  if (
    !context.groupId ||
    context.threadId ||
    context.executionTaskId ||
    context.routineRunId ||
    (context.todoRun?.paused && context.todoRun.paused.reason !== "checkpoint")
  )
    return undefined;
  const run = service.runs.get(context.runId);
  const group = service.groups.get(context.groupId);
  if (
    !run ||
    !group ||
    !run.cycleId ||
    run.status !== "running" ||
    (run.kind !== "chat" && run.kind !== "wake") ||
    run.botId !== context.botId ||
    run.messageId !== context.messageId ||
    run.groupId !== group.id ||
    run.botId !== group.coordinatorBotId ||
    run.conversationId !== context.conversationId ||
    run.conversationId !== group.conversationId ||
    service.deps.local.tasks.hasPendingChildren(context) ||
    service.deps.local.approvals.repo.blocksTaskCompletion(run.id)
  )
    return undefined;
  if (run.taskId) {
    const task = service.tasks.get(run.taskId);
    // Main-chat admission creates a user-owned direct task too; it is not a delegated step.
    if (
      !task ||
      task.groupId !== group.id ||
      task.assigneeBotId !== run.botId ||
      task.source?.kind !== "user" ||
      !task.source.available ||
      task.source.conversationId !== run.conversationId ||
      task.source.messageId !== run.userMessageId ||
      service.tasks.hasPendingChildren(task.id) ||
      service.deps.chat.queue.pendingTaskReplies(task.id, run.id)
    )
      return undefined;
  }
  const card = service.plans.repo.forCycle(run.conversationId, run.cycleId)?.card;
  if (card && ["pending", "ready", "starting"].includes(card.status)) return undefined;
  const summary = service.workflows.repo.executionSummary(
    group.id,
    run.conversationId,
    run.cycleId,
  );
  const pause = context.todoRun?.paused;
  if (pause?.reason === "checkpoint" && pause.groupPlanId) {
    const completedPlan = service.workflows.repo.byPlan(pause.groupPlanId);
    if (
      completedPlan &&
      completedReplacement(service, completedPlan) &&
      completedPlan.groupId === group.id &&
      completedPlan.cycleId === run.cycleId
    ) {
      delete context.todoRun?.paused;
      new MessagesRepo(service.deps.db).clearPlanCheckpoint(run.id, pause.groupPlanId);
    }
  }
  const calls = summary.plans
    ? (service.deps.local.tools.forMessages([context.messageId]).get(context.messageId) ?? [])
    : [];
  const coordinatorWorked = calls.some(
    (call) =>
      call.status === "done" &&
      [
        "write_file",
        "edit_file",
        "apply_patch",
        "run_command",
        "office_create",
        "office_edit",
      ].includes(call.tool),
  );
  // Tool facts do not change step ownership or assert that a still-active plan has passed.
  if (summary.active && (!coordinatorWorked || !summary.plans)) return undefined;
  if (context.todoRun?.paused && !summary.plans) return undefined;
  if (summary.plans)
    return {
      kind: "plan",
      steps: summary.steps,
      ...(coordinatorWorked ? { coordinatorWorked: true } : {}),
      ...(summary.active ? { inProgress: true } : {}),
      ...(summary.acceptanceRelaxed ? { acceptanceRelaxed: true } : {}),
      relaxations: service.workflows.repo.executionRelaxations(
        group.id,
        run.conversationId,
        run.cycleId,
      ),
    };
  // Legacy hand-offs are real delegation too; absence of a DAG cannot prove solo completion.
  return summary.delegated ? undefined : { kind: "solo" };
}
