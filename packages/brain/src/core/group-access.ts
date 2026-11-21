import type { DatabaseSync } from "node:sqlite";
import { type Group, type Message, RpcError } from "@pibot/protocol-base";
import {
  BotsRepo,
  ConversationsRepo,
  GroupsRepo,
  GroupTasksRepo,
  ImageArtifactsRepo,
  RunsRepo,
} from "@pibot/storage";

/** Shared group identity guard used by L2 capabilities and L4 orchestration. */
export function activeGroup(
  db: DatabaseSync,
  groupId: string,
  botId?: string,
  conversationId?: string,
  allowArchived = false,
): Group {
  const group = new GroupsRepo(db).get(groupId);
  if (!group || group.archivedAt) throw new RpcError(-32602, "Unknown group");
  if (!allowArchived && group.topicArchivedAt) throw new RpcError(-32602, "group_topic_archived");
  const bots = new BotsRepo(db);
  for (const member of allowArchived ? [] : group.members) {
    const bot = bots.get(member.botId);
    if (!bot || bot.archivedAt)
      throw new RpcError(-32602, "Group contains archived Bot; update members first");
  }
  if (botId && !group.members.some((member) => member.botId === botId))
    throw new RpcError(-32602, "Bot is not a member");
  if (conversationId) {
    const conversation = new ConversationsRepo(db).get(conversationId);
    if (
      !conversation ||
      conversation.groupId !== group.id ||
      conversation.archivedAt ||
      (conversation.kind !== "group" && conversation.kind !== "thread") ||
      (!allowArchived &&
        conversation.kind === "group" &&
        conversation.id !== group.conversationId) ||
      (!allowArchived &&
        conversation.kind === "thread" &&
        conversation.threadOf !== group.conversationId)
    )
      throw new RpcError(-32602, "Wrong group conversation");
  }
  return group;
}

export function requireGroupMember(deps: { db: DatabaseSync }, groupId: string, botId?: string) {
  const group = new GroupsRepo(deps.db).get(groupId);
  if (!group || group.archivedAt) throw new RpcError(-32602, "group_resource_unavailable");
  if (botId) {
    const bot = new BotsRepo(deps.db).get(botId);
    if (!group.members.some((member) => member.botId === botId) || !bot || bot.archivedAt)
      throw new RpcError(-32602, "group_member_unavailable");
  }
  return group;
}

/** Rebuild visibility from durable ownership; snapshots and model text never grant access. */
export function visibleGroupMessage(db: DatabaseSync, group: Group, message: Message): boolean {
  const run = message.runId ? new RunsRepo(db).get(message.runId) : undefined;
  const recoveringGeneratedImage = !!(
    run &&
    new ImageArtifactsRepo(db).get(run.id)?.generatedAt &&
    ["error", "aborted"].includes(run.status) &&
    ["done", "error", "aborted"].includes(message.status)
  );
  if (message.status !== "done" && !recoveringGeneratedImage) return false;
  if (recoveringGeneratedImage && run) {
    try {
      new ImageArtifactsRepo(db).resolveSource(run.id, {
        botId: group.coordinatorBotId,
        groupId: group.id,
        conversationId: group.conversationId,
      });
    } catch (error) {
      if (!(error instanceof TypeError && error.message.startsWith("image_artifact_"))) throw error;
      return false;
    }
  }
  const conversation = new ConversationsRepo(db).get(message.conversationId);
  if (
    !conversation ||
    conversation.archivedAt ||
    conversation.groupId !== group.id ||
    (conversation.kind !== "group" && conversation.kind !== "thread") ||
    (conversation.kind === "group" && conversation.id !== group.conversationId) ||
    (conversation.kind === "thread" && conversation.threadOf !== group.conversationId)
  )
    return false;
  if (message.botId) {
    const bot = new BotsRepo(db).get(message.botId);
    if (!bot || bot.archivedAt || !group.members.some((member) => member.botId === bot.id))
      return false;
  }
  if (message.runId) {
    if (
      !run ||
      run.groupId !== group.id ||
      run.botId !== message.botId ||
      run.conversationId !== message.conversationId ||
      (run.status !== "done" && !recoveringGeneratedImage)
    )
      return false;
    if (conversation.kind === "thread") {
      const task = new GroupTasksRepo(db, (text) => text).forThread(conversation.id);
      if (
        !task ||
        task.groupId !== group.id ||
        task.assigneeBotId !== message.botId ||
        run.taskId !== task.id
      )
        return false;
    }
  }
  if (message.taskResult) {
    const task = new GroupTasksRepo(db, (text) => text).get(message.taskResult.taskId);
    if (
      !task ||
      task.groupId !== group.id ||
      task.status !== "done" ||
      task.assigneeBotId !== message.botId ||
      task.threadConversationId !== message.taskResult.threadId
    )
      return false;
  }
  return true;
}
