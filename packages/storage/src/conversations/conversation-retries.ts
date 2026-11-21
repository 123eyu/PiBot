import type { DatabaseSync } from "node:sqlite";
import { ConversationRetryReceiptSchema } from "@pibot/protocol-base";
import { RunsRepo } from "../runs/runs.ts";
import { MessagesRepo } from "../workspace/repositories.ts";

export interface RetrySource {
  botId: string;
  conversationId: string;
  messageId: string;
}
export class ConversationRetriesRepo {
  constructor(private readonly db: DatabaseSync) {}
  boundary(messageId: string) {
    const row = this.db
      .prepare(
        "SELECT session_file AS file, entry_id AS entry, origin_message_id AS origin FROM conversation_retry_boundaries WHERE message_id=?",
      )
      .get(messageId);
    return row
      ? {
          file: String(row.file),
          entry: String(row.entry),
          origin: row.origin ? String(row.origin) : undefined,
        }
      : undefined;
  }
  bind(messageId: string, file: string, entry: string, origin?: string) {
    this.db
      .prepare(
        "INSERT INTO conversation_retry_boundaries(message_id,session_file,entry_id,origin_message_id) VALUES (?,?,?,?) ON CONFLICT(message_id) DO NOTHING",
      )
      .run(messageId, file, entry, origin ?? null);
  }
  receipt(requestId: string, source: RetrySource, hash?: string) {
    const row = this.db
      .prepare("SELECT * FROM conversation_retries WHERE request_id=?")
      .get(requestId);
    if (!row) return undefined;
    if (
      row.bot_id !== source.botId ||
      row.source_conversation_id !== source.conversationId ||
      row.message_id !== source.messageId ||
      (hash !== undefined && row.plan_hash !== hash)
    )
      throw new Error("retry_request_conflict");
    return ConversationRetryReceiptSchema.parse({
      requestId,
      state: row.state,
      botId: row.bot_id,
      conversationId: row.conversation_id,
    });
  }
  begin(requestId: string, source: RetrySource, hash: string) {
    this.db
      .prepare(
        "INSERT INTO conversation_retries(request_id,bot_id,source_conversation_id,message_id,plan_hash,state,created_at) VALUES (?,?,?,?,?,'pending',?)",
      )
      .run(
        requestId,
        source.botId,
        source.conversationId,
        source.messageId,
        hash,
        new Date().toISOString(),
      );
  }
  finish(requestId: string, conversationId: string) {
    this.db
      .prepare(
        "UPDATE conversation_retries SET state='done',conversation_id=? WHERE request_id=? AND state='pending'",
      )
      .run(conversationId, requestId);
  }
  fail(requestId: string) {
    this.db
      .prepare(
        "UPDATE conversation_retries SET state='failed' WHERE request_id=? AND state='pending'",
      )
      .run(requestId);
  }
  recover() {
    this.db.prepare("UPDATE conversation_retries SET state='failed' WHERE state='pending'").run();
  }
  runsAfter(runId: string, conversationId: string) {
    const rows = this.db
      .prepare(`WITH RECURSIVE suffix(id) AS (
      SELECT r.id FROM runs r JOIN runs source ON source.id=? WHERE r.conversation_id=source.conversation_id AND r.rowid>=source.rowid
      UNION SELECT id FROM runs WHERE conversation_id=? AND conversation_id<>(SELECT conversation_id FROM runs WHERE id=?)
      UNION SELECT child.id FROM runs child JOIN suffix parent ON child.parent_run_id=parent.id LIMIT 201
    ) SELECT r.id FROM runs r JOIN suffix s ON s.id=r.id ORDER BY r.finished_at DESC,r.rowid DESC LIMIT 201`)
      .all(runId, conversationId, runId);
    if (rows.length > 200) throw new Error("retry_history_limit");
    const repo = new RunsRepo(this.db);
    return rows.map((row) => {
      const value = repo.get(String(row.id));
      if (!value) throw new Error("retry_history_changed");
      return value;
    });
  }
  draft(botId: string, conversationId: string) {
    const row = this.db
      .prepare(
        "SELECT message_id FROM conversation_retries WHERE bot_id=? AND conversation_id=? AND state='done' AND NOT EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND role='user' AND run_id IS NOT NULL)",
      )
      .get(botId, conversationId, conversationId);
    return row ? new MessagesRepo(this.db).get(String(row.message_id)) : undefined;
  }
  messages(conversationId: string, messageId: string, section: "before" | "after") {
    const rows = this.db
      .prepare(
        `SELECT id FROM messages WHERE conversation_id=? AND rowid ${section === "before" ? "<" : ">="} (SELECT rowid FROM messages WHERE id=? AND conversation_id=?) ORDER BY rowid LIMIT 1001`,
      )
      .all(conversationId, messageId, conversationId);
    if (rows.length > 1000) throw new Error("retry_history_limit");
    const repo = new MessagesRepo(this.db);
    return rows.map((row) => {
      const value = repo.get(String(row.id));
      if (!value) throw new Error("retry_history_changed");
      return value;
    });
  }
}
