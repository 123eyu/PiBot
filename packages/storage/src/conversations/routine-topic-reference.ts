import type { DatabaseSync } from "node:sqlite";
import { MessageSchema } from "@pibot/protocol-base";

const referenceMessage = MessageSchema.pick({
  id: true,
  botId: true,
  role: true,
  status: true,
  content: true,
  createdAt: true,
  routineTrigger: true,
});

/** Text only: tool output, attachments, usage and automatic-session state stay outside chat. */
export function routineTopicReference(
  db: DatabaseSync,
  conversationId: string,
  botId: string,
  beforeMessageId: string,
  sourceRunId: string,
) {
  // Bound the window before looking for a trigger: old tasks must not cause an unbounded scan.
  const rows = db
    .prepare(`WITH anchor AS (
      SELECT m.created_at,m.rowid AS position FROM messages m
      JOIN conversations c ON c.id=m.conversation_id
      WHERE m.id=? AND m.run_id=? AND m.conversation_id=? AND m.role='user' AND m.status='done'
      AND m.bot_id IS NULL AND m.routine_trigger IS NULL
      AND c.kind='dm' AND c.bot_id=? AND c.routine_id IS NOT NULL AND c.archived_at IS NULL
    ), recent AS (
      SELECT m.rowid AS position,m.id,m.conversation_id,m.bot_id,m.role,m.status,m.run_id,m.created_at,
        m.updated_at,a.created_at AS cutoff,
        substr(m.content,1,5501) AS content,m.routine_trigger
        FROM messages m,anchor a WHERE m.conversation_id=?
      AND (m.created_at<a.created_at OR (m.created_at=a.created_at AND m.rowid<a.position))
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT 80
    ) SELECT m.id,m.bot_id AS botId,m.role,m.status,substr(m.content,1,5501) AS content,
      m.created_at AS createdAt,m.routine_trigger AS routineTrigger,
      CASE WHEN m.updated_at<=m.cutoff THEN 1 ELSE 0 END AS earlier,
      CASE WHEN r.kind='routine' AND r.automatic=1 AND r.group_id IS NULL
        AND m.updated_at<=m.cutoff
        AND r.conversation_id=m.conversation_id AND r.bot_id=?
        AND r.message_id=m.id AND r.status='done' THEN r.user_message_id END AS triggerId
      FROM recent m LEFT JOIN runs r ON r.id=m.run_id
      ORDER BY m.created_at DESC,m.position DESC`)
    .all(beforeMessageId, sourceRunId, conversationId, botId, conversationId, botId)
    .map(({ triggerId, earlier, ...row }) => ({
      message: referenceMessage.parse({
        ...row,
        routineTrigger:
          row.routineTrigger == null ? undefined : JSON.parse(String(row.routineTrigger)),
      }),
      triggerId,
      earlier,
    }));
  const triggerIndex = rows.findIndex(
    ({ message }) =>
      message.role === "user" &&
      message.botId === null &&
      message.status === "done" &&
      message.routineTrigger,
  );
  const trigger = rows[triggerIndex]?.message;
  if (!trigger || rows[triggerIndex]?.earlier !== 1) return undefined;
  const result = rows
    .slice(0, triggerIndex)
    .find(
      ({ message, triggerId }) =>
        triggerId === trigger.id &&
        message.role === "assistant" &&
        message.botId === botId &&
        message.status === "done",
    )?.message;
  return result ? { trigger, result } : undefined;
}
