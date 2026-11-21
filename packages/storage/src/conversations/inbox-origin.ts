import type { DatabaseSync } from "node:sqlite";
import { InboxOriginSchema } from "@pibot/protocol-base";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/** Source identities come from validated inbox records, never from model-written card text. */
export function inboxOrigin(
  db: DatabaseSync,
  item: Record<string, unknown>,
  messageId: string | null,
) {
  const owner = record(
    item.approval ?? item.proposal ?? item.notice ?? item.todo ?? item.run ?? item.routine,
  );
  const message = record(item.message);
  const sourceMessage = messageId ?? text(message.id) ?? text(owner.triggerMessageId);
  const persisted = sourceMessage
    ? db.prepare("SELECT id,bot_id,conversation_id FROM messages WHERE id=?").get(sourceMessage)
    : undefined;
  const botId = text(persisted?.bot_id) ?? text(owner.botId) ?? text(owner.sourceBotId);
  const conversationId =
    text(persisted?.conversation_id) ??
    text(item.conversationId) ??
    text(owner.conversationId) ??
    text(owner.sourceConversationId) ??
    text(owner.topicConversationId);
  const place = conversationId
    ? db
        .prepare(`SELECT c.id,c.title,c.kind,c.bot_id,c.group_id,g.name AS group_name
        FROM conversations c LEFT JOIN groups g ON g.id=c.group_id
        WHERE c.id=? AND c.internal_task_id IS NULL AND c.archived_at IS NULL`)
        .get(conversationId)
    : undefined;
  const id = botId ?? text(place?.bot_id);
  const bot = id ? db.prepare("SELECT name FROM bots WHERE id=?").get(id) : undefined;
  return InboxOriginSchema.parse({
    botId: id,
    botName: text(bot?.name)?.slice(0, 200) ?? null,
    groupId: text(place?.group_id),
    groupName: text(place?.group_name)?.slice(0, 200) ?? null,
    conversationId: text(place?.id),
    conversationTitle: text(place?.title)?.slice(0, 200) ?? null,
    conversationKind: place?.kind ?? null,
    messageId:
      place && persisted && persisted.conversation_id === place.id ? text(persisted.id) : null,
  });
}
