import { type Message, MessageSchema } from "@pibot/protocol";
import { z } from "zod";
import type { Caller } from "../../chat/controls/scope.ts";

export interface RunRef {
  runId: string;
  botId: string;
  conversationId: string;
  groupId?: string | null;
  taskId?: string | null;
  userMessageId?: string | null;
}
export const RunMessagesSchema = z.strictObject({
  request: MessageSchema.nullable(),
  reply: MessageSchema.nullable(),
});
export type RunMessages = z.infer<typeof RunMessagesSchema>;
// History pages are capped by the frame size; four pages reach well past a week of a topic.
const PAGES = 4,
  PAGE = 50;

function pick(messages: Message[], run: RunRef): RunMessages {
  const own = messages.filter((m) => m.runId === run.runId);
  const reply = own.filter((m) => m.role !== "user").at(-1) ?? null;
  const request =
    messages.find((m) => run.userMessageId && m.id === run.userMessageId) ??
    own.find((m) => m.role === "user") ??
    null;
  return { request, reply };
}
/**
 * The request and the final reply (with its tool steps and attachments) of one run, read from
 * the conversation it ran in. Only reads already on the phone whitelist are used.
 */
export async function readRunMessages(
  c: Caller,
  run: RunRef,
  signal?: AbortSignal,
): Promise<RunMessages> {
  if (run.groupId && run.taskId) {
    const page = await c.call(
      "groups.tasks.history",
      { groupId: run.groupId, taskId: run.taskId, limit: PAGE },
      signal,
    );
    return pick(page.messages, run);
  }
  const target = run.groupId
    ? { groupId: run.groupId, topicId: run.conversationId }
    : { botId: run.botId, topicId: run.conversationId };
  const seen: Message[] = [];
  let before: string | undefined;
  for (let i = 0; i < PAGES; i++) {
    const page = await c.call("chat.history", { ...target, before, limit: PAGE }, signal);
    seen.unshift(...page);
    const found = pick(seen, run);
    if ((found.reply && found.request) || page.length < PAGE) return found;
    before = page[0]?.id;
  }
  return pick(seen, run);
}
