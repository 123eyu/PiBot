import type { Group } from "@pibot/protocol-base";
import type { GroupService } from "./group-service.ts";

const HELD = new Set(["pending", "ready", "starting"]);

/**
 * While a dynamic plan awaits confirmation or runs, a main-chat message supplements it
 * instead of replacing the cycle (which hard-stops the plan, supersedes its queued steps and
 * stales its card). Only the user's explicit stop ends a running plan. Called inside the send
 * transaction so the decision and the queued run see the same plan state.
 */
export function planSupplement(
  service: GroupService,
  group: Pick<Group, "id" | "conversationId">,
): { cycleId: string; note: string; budgetRootRunId?: string } | undefined {
  const cycle = service.cycles.get(group.id);
  // A program decision stays explicit even if another limit stopped the same cycle.
  if (!cycle.cycleId) return undefined;
  const attempt = service.plans.repo.attemptState(group.id, cycle.cycleId);
  if (
    attempt?.status === "solo" &&
    !service.runs.hasActiveForCycle(group.id, cycle.cycleId) &&
    !(
      attempt.continuationRunId &&
      service.deps.local.background.followedRun(attempt.continuationRunId).waiting
    )
  )
    return undefined;
  if (attempt?.status === "waiting" || attempt?.status === "solo")
    return {
      cycleId: cycle.cycleId,
      note:
        attempt.status === "waiting"
          ? "计划上限处置等待用户点击卡片；只说明阻塞，不执行 / The plan limit awaits the user's card choice; explain the block without executing."
          : "用户已明确选择由统筹自行完成，保持原权限与预算 / The user explicitly chose solo execution under existing permissions and budget.",
    };
  if (cycle.limited) return undefined;
  const running = service.workflows.repo.activePlan(group.id, cycle.cycleId);
  if (running) {
    // Program facts only (step keys are schema-restricted ids); no model-written plan prose.
    const progress = service.workflows.repo
      .steps(running.id)
      .map((step) => ({ step: step.stepId, status: step.status, attempt: step.attempt }));
    return {
      cycleId: cycle.cycleId,
      note: [
        `本群的计划正在由程序执行。下面是用户在主对话里的补充或提问：回答进度、记下补充；不要重新提交计划或另行分派，计划会继续。 / The program is executing this group's plan. Below is the user's supplement or question: answer progress or note it; do not resubmit the plan or assign work. The plan continues.`,
        `计划进度（程序记录） / Plan progress (program facts): ${JSON.stringify(progress)}`,
      ].join("\n"),
    };
  }
  const card = service.plans.repo.forCycle(group.conversationId, cycle.cycleId)?.card;
  if (card?.status === "modify" && card.startFailure)
    return {
      cycleId: cycle.cycleId,
      budgetRootRunId: card.budgetRootRunId,
      note: `计划尚未登记执行。按失败原因核对输入后，可重新提交 group_plan，保持原预算；不要另行分派 / The plan has not been admitted. Check the failure and resubmit group_plan under the original budget; do not assign independently.\n${JSON.stringify(card.startFailure)}`,
    };
  if (!card || !HELD.has(card.status)) return undefined;
  return {
    cycleId: cycle.cycleId,
    note: `本群的计划卡片正在等待用户点「开始 / 修改」。下面是用户的补充或提问：直接回答；不要重新提交计划或另行分派。 / The plan card awaits the user's Start / Modify. Below is the user's supplement or question: answer it; do not resubmit the plan or assign work.`,
  };
}
