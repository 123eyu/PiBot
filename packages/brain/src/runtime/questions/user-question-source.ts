import { type Message, RpcError, UserQuestionPauseSchema } from "@pibot/protocol-base";
import {
  BotsRepo,
  ConversationsRepo,
  GroupsRepo,
  GroupTasksRepo,
  hasRoutineQuestionUserOrigin,
  MessagesRepo,
  RunsRepo,
} from "@pibot/storage";
import type { LocalService } from "../../local-service.ts";

const pauseOf = (message: Message | undefined) => {
  const usage = message?.usage;
  return UserQuestionPauseSchema.safeParse(
    usage && typeof usage === "object" && !Array.isArray(usage) ? usage.executionPause : undefined,
  );
};
/** A forwarded result can answer only its own original question in this same group. */
export function readUserQuestion(local: LocalService, messageId: string) {
  const messages = new MessagesRepo(local.deps.db),
    conversations = new ConversationsRepo(local.deps.db);
  const display = messages.get(messageId),
    shown = pauseOf(display);
  if (display?.role !== "assistant" || display.status !== "done" || !shown.success)
    throw new RpcError(-32602, "question_unavailable");
  const message = shown.data.sourceMessageId ? messages.get(shown.data.sourceMessageId) : display;
  const pause = pauseOf(message);
  const source = message ? conversations.get(message.conversationId) : undefined;
  const conversation = conversations.get(display.conversationId);
  const bot = message?.botId ? new BotsRepo(local.deps.db).get(message.botId) : undefined;
  const run = message?.runId ? new RunsRepo(local.deps.db).get(message.runId) : undefined;
  if (
    message?.role !== "assistant" ||
    message.status !== "done" ||
    !bot ||
    bot.archivedAt ||
    !source ||
    source.archivedAt ||
    conversations.isInternal(source.id) ||
    !conversation ||
    conversation.archivedAt ||
    !run ||
    run.status !== "done" ||
    !["chat", "wake", "group_task"].includes(run.kind) ||
    run.botId !== bot.id ||
    run.messageId !== message.id ||
    run.conversationId !== source.id ||
    !pause.success ||
    pause.data.sourceMessageId ||
    display.botId !== bot.id
  )
    throw new RpcError(-32602, "question_unavailable");
  // Background completion is ordinary chat only when its persisted parent chain leads
  // to a real user turn. Never borrow an autonomous routine's permission or send lane.
  if (source.routineId !== null && !hasRoutineQuestionUserOrigin(local.deps.db, run.id))
    throw new RpcError(-32602, "question_unavailable");
  if (run.kind !== "chat") {
    // Group wake and native member runs share this user-visible send lane, not the internal
    // execution-task lane. Their persisted source must still belong to the same live group.
    const group = source.groupId ? new GroupsRepo(local.deps.db).get(source.groupId) : undefined;
    if (
      !group ||
      run.groupId !== group.id ||
      (source.kind === "group"
        ? source.id !== group.conversationId
        : source.kind !== "thread" || source.threadOf !== group.conversationId)
    )
      throw new RpcError(-32602, "question_unavailable");
    if (source.kind === "thread" || run.kind === "group_task") {
      const task = new GroupTasksRepo(local.deps.db, (text) =>
        local.deps.redactor.redact(text),
      ).forThread(source.id);
      if (
        !task ||
        task.id !== run.taskId ||
        task.groupId !== group.id ||
        task.assigneeBotId !== bot.id
      )
        throw new RpcError(-32602, "question_unavailable");
    }
    if (run.kind === "wake") {
      const parent = run.parentRunId ? new RunsRepo(local.deps.db).get(run.parentRunId) : undefined;
      if (!parent || parent.groupId !== group.id)
        throw new RpcError(-32602, "question_unavailable");
    }
  }
  if (
    message.id !== display.id &&
    (source.threadOf !== conversation.id ||
      conversation.kind !== "group" ||
      !source.groupId ||
      source.groupId !== conversation.groupId ||
      JSON.stringify(shown.data.question) !== JSON.stringify(pause.data.question))
  )
    throw new RpcError(-32602, "question_unavailable");
  if (conversation.kind === "dm" && conversation.botId !== bot.id)
    throw new RpcError(-32602, "question_unavailable");
  if (
    conversation.groupId &&
    !new GroupsRepo(local.deps.db)
      .get(conversation.groupId)
      ?.members.some((member) => member.botId === bot.id)
  )
    throw new RpcError(-32602, "question_unavailable");
  return { display, message, pause: pause.data, conversation, bot };
}
