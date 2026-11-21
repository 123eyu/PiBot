import { outputBasename, requestedOutputNames } from "@pibot/brain/orchestration-kit";
import { type GroupPlan, RpcError } from "@pibot/protocol-base";
import { ConversationsRepo, MessagesRepo } from "@pibot/storage";
import type { PlanIssue } from "./group-plan-validation.ts";
import type { GroupService } from "./group-service.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";

/** A task id in model text proves nothing; require the persisted step, owner and run anchor. */
export function stepOutputNames(service: GroupService, runId: string): readonly string[] {
  const run = service.runs.get(runId);
  if ((run?.kind !== "group_task" && run?.kind !== "wake") || !run.taskId || !run.groupId)
    return [];
  const task = service.tasks.get(run.taskId);
  const handoff = service.handoffs.repo.get(run.taskId);
  const ref = handoff?.spec.workflowStep;
  const record = ref ? service.workflows.repo.get(ref.workflowRunId) : undefined;
  const step =
    record && service.workflows.repo.steps(record.id).find((item) => item.stepId === ref?.stepId);
  const anchor = step?.executionRunId ? service.runs.get(step.executionRunId) : undefined;
  const origin = record?.budgetRootRunId ? service.runs.get(record.budgetRootRunId) : undefined;
  if (
    !task ||
    !record ||
    !step ||
    !anchor ||
    !origin ||
    task.groupId !== run.groupId ||
    task.assigneeBotId !== run.botId ||
    task.threadConversationId !== run.conversationId ||
    record.groupId !== run.groupId ||
    record.cycleId !== run.cycleId ||
    step.taskId !== task.id ||
    step.ownerBotId !== run.botId ||
    anchor.taskId !== task.id ||
    anchor.botId !== run.botId ||
    anchor.kind !== "group_task" ||
    anchor.groupId !== run.groupId ||
    anchor.cycleId !== run.cycleId ||
    anchor.conversationId !== run.conversationId ||
    origin.groupId !== record.groupId ||
    origin.cycleId !== record.cycleId ||
    origin.botId !== record.coordinatorBotId ||
    task.createdByBotId !== record.coordinatorBotId ||
    new ConversationsRepo(service.deps.db).get(task.threadConversationId)?.threadOf !==
      origin.conversationId
  )
    return [];
  let workflow: ReturnType<typeof workflowOf>;
  try {
    workflow = workflowOf(record);
  } catch (error) {
    // Corrupt historical snapshots vouch for no naming exception; program errors still propagate.
    if (error instanceof RpcError && error.message === "group_workflow_snapshot_invalid") return [];
    throw error;
  }
  const outputs = new Set(
    workflow.contract.steps
      ?.find((item) => item.id === step.stepId)
      ?.deliverables.map((item) => outputBasename(item.path)),
  );
  // The effective contract is authoritative even when the user did not dictate each filename.
  return [...outputs];
}

/** Replans retain the original user's request, not the program-authored replan wake text. */
export function planFilenameRequest(service: GroupService, runId: string): string {
  const run = service.runs.get(runId);
  if (!run?.groupId || !run.cycleId) return "";
  const replacing = service.workflows.repo.replanning(runId);
  const origin = replacing?.budgetRootRunId ? service.runs.get(replacing.budgetRootRunId) : run;
  if (
    !origin?.userMessageId ||
    origin.groupId !== run.groupId ||
    origin.conversationId !== run.conversationId ||
    origin.cycleId !== run.cycleId
  )
    return "";
  const message = new MessagesRepo(service.deps.db).get(origin.userMessageId);
  return message?.role === "user" && message.conversationId === run.conversationId
    ? message.content
    : "";
}

/** Intermediate outputs may use other names; every explicitly requested output must be present. */
export function planFilenameIssues(plan: GroupPlan, request: string): PlanIssue[] {
  const outputs = new Set(
    plan.steps.flatMap((step) => step.deliverables.map((item) => outputBasename(item.path))),
  );
  return requestedOutputNames(request)
    .filter((name) => !outputs.has(name))
    .map((name) => ({
      code: "plan_requested_filename_missing",
      path: ["steps"],
      expected: `用户指定的交付文件名必须保留：${name} / Keep the user's requested output filename: ${name}`,
    }));
}
