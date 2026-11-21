import type { QueueInput } from "@pibot/brain/orchestration-kit";
import { continuationKey } from "@pibot/brain/orchestration-kit";
import type { Run } from "@pibot/protocol-base";
import { BotsRepo, MessagesRepo } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

export async function continueGroup(service: GroupService, record: Run, input: QueueInput) {
  if (!service.interactive) return;
  if (record.status !== "done" || !input.replyToRunId || !record.groupId || !record.cycleId) return;
  const source = service.runs.get(input.replyToRunId);
  if (source?.status !== "done") return;
  const group = service.active(record.groupId);
  if (service.cycles.get(group.id).cycleId !== record.cycleId || group.paused) return;
  const request = source.userMessageId
    ? new MessagesRepo(service.deps.db).get(source.userMessageId)
    : undefined;
  if (
    request?.role === "user" &&
    (request.mentions?.length ?? 0) > 1 &&
    request.mentions?.includes(source.botId)
  )
    return;
  const task = source.taskId ? service.tasks.get(source.taskId) : undefined;
  if (task && task.status !== "open") return;
  const bot = new BotsRepo(service.deps.db).get(source.botId);
  if (!bot || bot.archivedAt) return;
  const key = continuationKey("reply", source.id, record.id);
  if (service.runs.trigger(key)) return;
  const answer = new MessagesRepo(service.deps.db).get(record.messageId);
  const queueInput: QueueInput = {
    bot,
    conversationId: source.conversationId,
    groupId: group.id,
    ...(source.conversationId !== group.conversationId ? { threadId: source.conversationId } : {}),
    taskId: source.taskId ?? undefined,
    userMessageId: source.userMessageId ?? undefined,
    cycleId: record.cycleId,
    automatic: true,
    kind: "wake",
    parentRunId: record.id,
    triggerKey: key,
    ancestry: source.ancestry,
    text: service.deps.redactor.redact(
      `Member answer / 成员回答 (${record.botId}):\n${answer?.content ?? ""}`,
    ),
  };
  const result = service.auto(group.id, record.cycleId, () => {
    service.deps.chat.queue.capacity([bot.id]);
    return service.deps.chat.queue.insert(queueInput);
  });
  if (result.value) service.deps.chat.queue.publish(result.value, queueInput);
}
