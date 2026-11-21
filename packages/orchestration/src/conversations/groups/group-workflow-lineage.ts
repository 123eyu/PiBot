import { RpcError } from "@pibot/protocol-base";
import type { GroupWorkflowRunRecord } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";

const invalid = () => new RpcError(-32602, "group_workflow_lineage_unavailable");
const PREFIX = "group-replan:";

/** Admission leaves both ends of each replacement edge durable; a shared budget is not an edge. */
export function planReplacementChain(service: GroupService, record: GroupWorkflowRunRecord) {
  const chain = [record];
  const seen = new Set([record.id]);
  for (;;) {
    const current = chain.at(-1);
    if (!current) throw invalid();
    const source = workflowOf(current).source;
    if (source.kind !== "dynamic") return chain;
    const origin = service.runs.get(source.originRunId);
    if (!origin?.triggerKey?.startsWith(PREFIX)) return chain;
    const previous = service.workflows.repo.get(origin.triggerKey.slice(PREFIX.length));
    if (
      chain.length >= 3 ||
      !previous ||
      seen.has(previous.id) ||
      origin.kind !== "wake" ||
      !origin.automatic ||
      origin.taskId ||
      origin.botId !== current.coordinatorBotId ||
      origin.groupId !== current.groupId ||
      origin.cycleId !== current.cycleId ||
      !current.budgetRootRunId ||
      origin.parentRunId !== current.budgetRootRunId ||
      origin.conversationId !== service.groups.get(current.groupId)?.conversationId ||
      previous.status !== "cancelled" ||
      previous.groupId !== current.groupId ||
      previous.cycleId !== current.cycleId ||
      previous.coordinatorBotId !== current.coordinatorBotId ||
      previous.budgetRootRunId !== current.budgetRootRunId ||
      workflowOf(previous).source.kind !== "dynamic" ||
      progressOf(previous).replanRunId !== origin.id
    )
      throw invalid();
    seen.add(previous.id);
    chain.push(previous);
  }
}

/** Late source replies may refer to a cancelled predecessor; require the actual accepted chain. */
export function completedReplacement(service: GroupService, record: GroupWorkflowRunRecord) {
  if (record.status === "passed") return record;
  if (record.status !== "cancelled" || !record.budgetRootRunId) return;
  const latest = service.workflows.repo.latestPlan(
    record.groupId,
    record.cycleId,
    record.budgetRootRunId,
  );
  if (
    latest?.status === "passed" &&
    planReplacementChain(service, latest).some((item) => item.id === record.id)
  )
    return latest;
}
