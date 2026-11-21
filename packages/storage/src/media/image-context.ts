import type { DatabaseSync } from "node:sqlite";
import type { Message } from "@pibot/protocol-base";
import { MessagesRepo } from "../workspace/repositories.ts";

/** Query image candidates directly: many intervening text messages must not hide the last picture. */
export class ImageContextRepo {
  constructor(private readonly db: DatabaseSync) {}
  before(conversationId: string, messageId: string): Message[] {
    const cursor = this.db
      .prepare("SELECT created_at,rowid FROM messages WHERE id=? AND conversation_id=?")
      .get(messageId, conversationId);
    if (!cursor) return [];
    const rows = this.db
      .prepare(`SELECT m.id FROM messages m WHERE m.conversation_id=?
      AND (m.created_at<? OR (m.created_at=? AND m.rowid<?))
      AND (EXISTS(SELECT 1 FROM attachments a WHERE a.message_id=m.id AND a.kind='image')
        OR EXISTS(SELECT 1 FROM message_attachment_links l JOIN attachments a ON a.id=l.attachment_id WHERE l.message_id=m.id AND a.kind='image'))
      ORDER BY m.created_at DESC,m.rowid DESC LIMIT 30`)
      .all(
        conversationId,
        String(cursor.created_at),
        String(cursor.created_at),
        Number(cursor.rowid),
      );
    const messages = new MessagesRepo(this.db);
    return rows.flatMap((row) => {
      const message = messages.get(String(row.id));
      return message ? [message] : [];
    });
  }
}
