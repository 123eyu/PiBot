import type { GroupTask } from "@pibot/protocol-base";
import { ConversationsRepo } from "@pibot/storage";
import { handoffUnmet } from "./group-handoff-check.ts";
import type { GroupService } from "./group-service.ts";

/** Only the program's returned hand-off chain can keep a logical task's consent alive. */
export function logicalWebTask(service: GroupService, task: GroupTask, cycleId: string) {
  const group = service.groups.get(task.groupId);
  const start = service.cycles.origin(task.id);
  if (!group || start?.cycleId !== cycleId) return;
  const source = service.runs.get(start.sourceRunId);
  if (
    !source ||
    source.groupId !== group.id ||
    source.cycleId !== cycleId ||
    source.botId !== group.coordinatorBotId ||
    source.conversationId !== group.conversationId
  )
    return;
  const conversations = new ConversationsRepo(service.deps.db);
  const seen = new Set<string>();
  let current = task;
  for (let depth = 0; depth < 16; depth++) {
    const origin = service.cycles.origin(current.id);
    const handoff = service.handoffs.repo.get(current.id);
    const thread = conversations.get(current.threadConversationId);
    if (
      seen.has(current.id) ||
      current.groupId !== group.id ||
      current.createdByBotId !== group.coordinatorBotId ||
      thread?.groupId !== group.id ||
      thread.threadOf !== group.conversationId ||
      origin?.cycleId !== cycleId ||
      origin.sourceRunId !== start.sourceRunId ||
      origin.sourceMessageId !== start.sourceMessageId ||
      handoff?.spec.workflowStep
    )
      return;
    seen.add(current.id);
    if (!handoff?.returnOf) return current.id;
    const parent = service.tasks.get(handoff.returnOf);
    const previous = parent && service.handoffs.repo.get(parent.id);
    const parentOrigin = parent && service.cycles.origin(parent.id);
    const finished = parentOrigin?.finishedRunId
      ? service.runs.get(parentOrigin.finishedRunId)
      : undefined;
    if (
      parent?.status !== "done" ||
      previous?.state !== "returned" ||
      !previous.result ||
      !handoffUnmet(previous.result) ||
      !parentOrigin?.wakeClaimed ||
      finished?.taskId !== parent.id ||
      finished.groupId !== group.id ||
      finished.cycleId !== cycleId ||
      finished.botId !== parent.assigneeBotId ||
      finished.conversationId !== parent.threadConversationId
    )
      return;
    current = parent;
  }
}

/** done precedes the asynchronous delivery check; it is not yet a final hand-off result. */
export function settleWebTaskConsent(service: GroupService, task: GroupTask) {
  if (task.status === "open") return;
  const origin = service.cycles.origin(task.id);
  const root = origin ? logicalWebTask(service, task, origin.cycleId) : undefined;
  const handoff = service.handoffs.repo.get(task.id);
  const checkingOrReturning =
    task.status === "done" &&
    handoff &&
    !handoff.result?.userResolved &&
    (handoff.state === "returned" ||
      (handoff.state === "pending" &&
        (!handoff.result || (!handoff.returnOf && handoffUnmet(handoff.result)))));
  if (!root || !checkingOrReturning)
    service.deps.local.approvals.revokeTaskWeb(`task:${root ?? task.id}`);
}
