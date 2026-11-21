import type { QueueInput } from "@pibot/brain/orchestration-kit";
import { collaborationAuditFields } from "@pibot/brain/orchestration-kit";
import type { GroupTask } from "@pibot/protocol-base";
import { BotsRepo, type HandoffRecord, MessagesRepo, transaction } from "@pibot/storage";
import { returnText, returnTitle, unmetNotice } from "./group-handoff-text.ts";
import type { GroupService } from "./group-service.ts";

interface Origin {
  cycleId: string;
  sourceMessageId: string;
  sourceRunId: string;
  finishedRunId: string;
}

/**
 * The program sends an unmet result back once on the coordinator's behalf
 * ("协调者可退回一次"), so a missing file costs no coordinator turn. The send-back is a new task
 * for the same member carrying only the missing items; it is itself a hand-off with the same
 * spec, and its completion is judged again. Counts as a hand-off, not an automatic round.
 */
export function sendBack(
  service: GroupService,
  task: GroupTask,
  record: HandoffRecord,
  origin: Origin,
): { runId?: string; reason?: string } {
  const group = service.groups.get(task.groupId);
  const bots = new BotsRepo(service.deps.db);
  const assignee = bots.get(task.assigneeBotId);
  if (!group) return { reason: "group_unavailable" };
  // A member who left cannot fix it: the user decides, as after a failed resubmission.
  if (!assignee || assignee.archivedAt || !group.members.some((m) => m.botId === assignee.id))
    return stopUnmet(service, task, record, origin);
  try {
    service.deps.chat.queue.capacity([assignee.id]);
  } catch {
    return { reason: "queue_full" };
  }
  const language = service.handoffs.language();
  const text = service.deps.redactor.redact(returnText(record, task.title, language));
  const sourceRun = service.runs.get(origin.sourceRunId);
  const result = transaction(service.deps.db, () =>
    service.auto(
      group.id,
      origin.cycleId,
      () => {
        if (!service.cycles.claimWake(task.id)) throw new Error("Hand-off already settled");
        const followUp = service.tasks.create({
          groupId: group.id,
          assigneeBotId: assignee.id,
          title: returnTitle(task.title, language),
          instructions: text,
          createdByBotId: group.coordinatorBotId,
          executionMode: task.executionMode ?? "serial",
        });
        service.cycles.bind(
          followUp.id,
          origin.cycleId,
          origin.sourceMessageId,
          origin.sourceRunId,
        );
        const bound = service.tasks.bindSource(followUp.id, origin.sourceRunId);
        service.handoffs.repo.create({
          taskId: followUp.id,
          spec: record.spec,
          pipeline: record.pipeline,
          baseFolder: record.baseFolder,
          returnOf: task.id,
        });
        service.handoffs.repo.setState(task.id, "returned");
        const message = new MessagesRepo(service.deps.db).create({
          conversationId: followUp.threadConversationId,
          botId: group.coordinatorBotId,
          role: "assistant",
          content: text,
          status: "done",
          runId: origin.sourceRunId,
        });
        const input: QueueInput = {
          bot: assignee,
          conversationId: followUp.threadConversationId,
          groupId: group.id,
          threadId: followUp.threadConversationId,
          taskId: followUp.id,
          userMessageId: message.id,
          cycleId: origin.cycleId,
          automatic: true,
          kind: "group_task",
          parentRunId: origin.finishedRunId,
          ancestry: [...(sourceRun?.ancestry ?? []), group.coordinatorBotId],
          triggerKey: `handoff-return:${task.id}`,
          text,
        };
        return { record: service.deps.chat.queue.insert(input), input, task: bound };
      },
      "handoff",
    ),
  );
  if (!result.value) return { reason: result.reason ?? "stopped" };
  service.handoffs.settled(task.id);
  service.deps.chat.queue.publish(result.value.record, result.value.input);
  service.taskChanged(result.value.task);
  const original = service.tasks.get(task.id);
  if (original) service.taskChanged(original);
  service.deps.local.approvals.audit.append({
    botId: group.coordinatorBotId,
    runId: origin.finishedRunId,
    kind: "collaboration.queued",
    summary: "Group hand-off sent back / 群交接已退回",
    detail: {
      ...collaborationAuditFields({
        action: "return",
        botName: bots.get(group.coordinatorBotId)?.name,
        targetBotName: assignee.name,
        taskTitle: task.title,
        actor: "system",
        redactor: service.deps.redactor,
      }),
      groupId: group.id,
      taskId: result.value.task.id,
      targetBotId: assignee.id,
      childRunId: result.value.record.id,
    },
  });
  return { runId: result.value.record.id };
}

/**
 * Still unmet after the send-back (or nobody left to fix it): stop this cycle and tell the user
 * what is missing. No coordinator turn: deciding what to do next is the user's call.
 */
export function stopUnmet(
  service: GroupService,
  task: GroupTask,
  record: HandoffRecord,
  origin: Origin,
): { reason: string } {
  const group = service.groups.get(task.groupId);
  if (!group) return { reason: "group_unavailable" };
  const content = service.deps.redactor.redact(unmetNotice(record, task.title));
  const stopped = transaction(service.deps.db, () => {
    if (!service.cycles.claimWake(task.id)) return false;
    service.handoffs.repo.setState(task.id, "unmet");
    service.cycles.limit(group.id, origin.cycleId);
    new MessagesRepo(service.deps.db).create({
      conversationId: group.conversationId,
      botId: group.coordinatorBotId,
      role: "assistant",
      content,
      status: "done",
    });
    return true;
  });
  if (!stopped) return { reason: "already_settled" };
  service.handoffs.settled(task.id);
  service.deps.logger.info(
    JSON.stringify({
      module: "group",
      event: "handoff_unmet_stopped",
      groupId: group.id,
      taskId: task.id,
      runId: origin.finishedRunId,
    }),
  );
  const cycle = service.cycles.get(group.id);
  service.deps.peer.emit("group.paused", {
    groupId: group.id,
    reason: "limit",
    rounds: cycle.rounds,
    limit: group.autoRoundLimit,
  });
  const current = service.tasks.get(task.id);
  if (current) service.taskChanged(current);
  else service.changed(group.id, "updated");
  return { reason: "handoff_unmet" };
}
