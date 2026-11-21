import type { Message, TaskSummary, TodoPlan } from "@pibot/protocol";
import type { ExecutionTopic } from "./types.ts";

export interface ReplyCards {
  plan?: TodoPlan;
  tasks: TaskSummary[];
}
const toolKey = (
  botId: string,
  conversationId: string,
  runId: string,
  tool: string,
  toolCallId: string,
) => JSON.stringify([botId, conversationId, runId, tool, toolCallId]);

/** Only authorized, loaded tool records prove a reply's origin; ambiguity never picks a latest reply. */
export function replyCards(
  topics: readonly ExecutionTopic[],
  conversationId: string | undefined,
  messages: readonly Message[],
) {
  const tools = new Map<string, Message | null>(),
    cards = new Map<string, ReplyCards>();
  if (!conversationId) return cards;
  for (const message of messages) {
    if (
      message.role !== "assistant" ||
      !message.botId ||
      !message.runId ||
      message.conversationId !== conversationId
    )
      continue;
    for (const tool of message.tools ?? []) {
      if (tool.tool !== "todo_update" && tool.tool !== "task_spawn") continue;
      const key = toolKey(message.botId, conversationId, message.runId, tool.tool, tool.toolCallId);
      tools.set(key, tools.has(key) ? null : message);
    }
  }
  const entry = (messageId: string) => {
    let value = cards.get(messageId);
    if (!value) {
      value = { tasks: [] };
      cards.set(messageId, value);
    }
    return value;
  };
  for (const topic of topics) {
    const plan = topic.plan,
      source = plan?.source;
    if (plan?.conversationId === conversationId && plan.botId === topic.botId && source) {
      const message = tools.get(
        toolKey(topic.botId, conversationId, source.runId, "todo_update", source.toolCallId),
      );
      if (message?.id === source.messageId) entry(message.id).plan = plan;
    }
    for (const task of topic.tasks) {
      if (
        task.archivedAt ||
        task.deletedAt ||
        task.botId !== topic.botId ||
        task.conversationId !== conversationId ||
        !task.sourceToolCallId
      )
        continue;
      const message = tools.get(
        toolKey(task.botId, conversationId, task.parentRunId, "task_spawn", task.sourceToolCallId),
      );
      if (message) entry(message.id).tasks.push(task);
    }
  }
  return cards;
}
