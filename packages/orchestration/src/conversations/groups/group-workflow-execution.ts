import type { Run } from "@pibot/protocol-base";
import type { GroupWorkflowRunRecord, GroupWorkflowStepRecord } from "@pibot/storage";
import { BackgroundContinuationsRepo } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

/** The bound run remains the anchor until settlement; a trigger prefix alone proves no lineage. */
export function stepExecution(
  service: GroupService,
  record: GroupWorkflowRunRecord,
  step: GroupWorkflowStepRecord,
) {
  const origin = step.executionRunId ? service.runs.get(step.executionRunId) : undefined;
  const belongs = (run: Run | undefined): run is Run =>
    !!run &&
    !!step.taskId &&
    run.taskId === step.taskId &&
    run.groupId === record.groupId &&
    run.cycleId === record.cycleId &&
    run.botId === step.ownerBotId &&
    run.kind === "group_task";
  if (!belongs(origin)) return;
  const followed = service.deps.local.background.followedRun(origin.id);
  let child = followed.run;
  for (let depth = 0; depth < 32; depth++) {
    if (!belongs(child) || child.conversationId !== origin.conversationId) return;
    if (child.id === origin.id) return followed;
    const prefix = "background_finished:";
    if (!child.parentRunId || !child.triggerKey?.startsWith(prefix)) return;
    const ids = new BackgroundContinuationsRepo(service.deps.db).jobs(child.id);
    if (
      ids.length &&
      new BackgroundContinuationsRepo(service.deps.db).trigger(ids) !== child.triggerKey
    )
      return;
    const command = (ids.length ? ids : [child.triggerKey.slice(prefix.length)])
      .map((id) => service.deps.local.background.repo.get(id))
      .find((row) => row?.runId === child?.parentRunId);
    if (
      !command ||
      command.runId !== child.parentRunId ||
      command.botId !== child.botId ||
      command.groupId !== child.groupId ||
      command.conversationId !== child.conversationId ||
      command.status === "running"
    )
      return;
    child = service.runs.get(child.parentRunId);
  }
}
