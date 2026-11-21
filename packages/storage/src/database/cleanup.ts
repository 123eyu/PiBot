import type { DatabaseSync } from "node:sqlite";

export interface CleanupManifest {
  sessionFiles: string[];
  attachmentPaths: string[];
  attachments: { id: string; botId: string; path: string; textPath: string | null }[];
}
// Only repository literals select the scope. Callers cancel runs before entering the outer transaction.
export function deleteConversations(
  db: DatabaseSync,
  scope: "bot_id" | "group_id",
  id: string,
): CleanupManifest {
  const conversations = `SELECT id FROM conversations WHERE ${scope}=?`;
  const messages = `SELECT id FROM messages WHERE conversation_id IN (${conversations})`;
  const sessionFiles = [
    ...new Set(
      db
        .prepare(
          `SELECT pi_session_file FROM bot_sessions WHERE conversation_id IN (${conversations})
           UNION SELECT pi_session_file FROM conversations WHERE ${scope}=? AND pi_session_file IS NOT NULL
           UNION SELECT session_file FROM runs WHERE conversation_id IN (${conversations}) AND session_file IS NOT NULL`,
        )
        .all(id, id, id)
        .map((r) => String(r.pi_session_file)),
    ),
  ];
  const attachments = db
    .prepare(
      `SELECT a.id,a.path,a.text_path AS textPath,COALESCE(a.owner_bot_id,m.bot_id,c.bot_id) AS botId FROM attachments a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id WHERE a.message_id IN (${messages})`,
    )
    .all(id)
    .map((r) => ({
      id: String(r.id),
      botId: String(r.botId),
      path: String(r.path),
      textPath: r.textPath === null ? null : String(r.textPath),
    }));
  const attachmentPaths = attachments.flatMap((a) =>
    [a.path, a.textPath].filter((v): v is string => v !== null),
  );
  if (
    db
      .prepare(
        `SELECT id FROM approvals WHERE status='pending' AND message_id IN (${messages}) LIMIT 1`,
      )
      .get(id)
  )
    throw new TypeError("Cancel pending approvals before deletion");
  db.prepare(`UPDATE tool_calls SET approval_id=NULL WHERE message_id IN (${messages})`).run(id);
  db.prepare(`DELETE FROM approvals WHERE message_id IN (${messages})`).run(id);
  db.prepare(`DELETE FROM tool_calls WHERE message_id IN (${messages})`).run(id);
  db.prepare(
    `UPDATE scoped_memories SET source_message_id=NULL WHERE source_message_id IN (${messages})`,
  ).run(id);
  db.prepare(
    `UPDATE scoped_memory_proposals SET message_id=NULL WHERE message_id IN (${messages})`,
  ).run(id);
  db.prepare(`DELETE FROM messages WHERE conversation_id IN (${conversations})`).run(id);
  db.prepare(`DELETE FROM bot_sessions WHERE conversation_id IN (${conversations})`).run(id);
  if (scope === "group_id") db.prepare("DELETE FROM group_tasks WHERE group_id=?").run(id);
  db.prepare(`DELETE FROM conversations WHERE ${scope}=? AND kind='thread'`).run(id);
  db.prepare(`DELETE FROM conversations WHERE ${scope}=?`).run(id);
  return { sessionFiles, attachmentPaths, attachments };
}

/**
 * Session files of a group's Bots that may hold saved group references, in stored form:
 * a topic and its threads, one member's files in the whole group, or the whole group. Both the
 * per-conversation session and per-run files (task runs, retry forks) count.
 */
export function groupSessionFiles(
  db: DatabaseSync,
  scope: { groupId: string; conversationId?: string; botId?: string },
): string[] {
  const conversations = scope.conversationId
    ? "SELECT id FROM conversations WHERE group_id=$group AND (id=$topic OR thread_of=$topic)"
    : "SELECT id FROM conversations WHERE group_id=$group";
  const bot = scope.botId ? " AND bot_id=$bot" : "";
  const params: Record<string, string> = { group: scope.groupId };
  if (scope.conversationId) params.topic = scope.conversationId;
  if (scope.botId) params.bot = scope.botId;
  const rows = db
    .prepare(
      `SELECT pi_session_file AS file FROM bot_sessions WHERE conversation_id IN (${conversations})${bot} UNION SELECT session_file AS file FROM runs WHERE session_file IS NOT NULL AND conversation_id IN (${conversations})${bot}`,
    )
    .all(params);
  return [...new Set(rows.map((row) => String(row.file)))];
}
