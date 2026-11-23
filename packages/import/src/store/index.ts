// A batch owns its imported rows, allowing atomic publication, rollback, and recovery.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type ImportStatus, ImportStatusSchema } from "@pibot/import-contract";
import { AuditRepo, transaction } from "@pibot/storage";

type ImportedTopic = {
  title: string;
  createdAt: string;
  updatedAt: string;
};
type ImportedMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

export class ImportStore {
  private readonly audit: AuditRepo;

  constructor(
    private readonly db: DatabaseSync,
    redactor: ConstructorParameters<typeof AuditRepo>[1],
  ) {
    this.audit = new AuditRepo(db, redactor);
  }

  availableBot(botId: string) {
    return !!this.db.prepare("SELECT 1 FROM bots WHERE id=? AND archived_at IS NULL").get(botId);
  }

  get(id: string) {
    const row = this.db
      .prepare(`SELECT id AS importId, source, state, topics, messages, reason
      FROM import_jobs WHERE id=?`)
      .get(id);
    return row ? ImportStatusSchema.parse(row) : undefined;
  }

  create(id: string, source: ImportStatus["source"], botId: string) {
    this.db
      .prepare("INSERT INTO import_jobs(id,source,bot_id,state) VALUES(?,?,?,'running')")
      .run(id, source, botId);
  }

  target(id: string) {
    return this.db.prepare("SELECT bot_id FROM import_jobs WHERE id=?").get(id)?.bot_id;
  }

  unfinished() {
    return this.db.prepare("SELECT id FROM import_jobs WHERE state='running' LIMIT 1").get()?.id;
  }

  addTopic(batchId: string, botId: string, source: ImportStatus["source"], topic: ImportedTopic) {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO conversations
      (id, kind, bot_id, title, created_at, updated_at, import_id, import_source)
      VALUES (?, 'dm', ?, ?, ?, ?, ?, ?)`)
      .run(id, botId, topic.title, topic.createdAt, topic.updatedAt, batchId, source);
    return id;
  }

  addMessage(batchId: string, botId: string, conversationId: string, msg: ImportedMessage) {
    this.db
      .prepare(`INSERT INTO messages
      (id, conversation_id, role, content, status, bot_id, created_at, updated_at, import_id)
      VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?)`)
      .run(
        randomUUID(),
        conversationId,
        msg.role,
        msg.text,
        msg.role === "user" ? null : botId,
        msg.createdAt,
        msg.createdAt,
        batchId,
      );
  }

  page<T>(id: string, add: () => T, counts: Pick<ImportStatus, "topics" | "messages">) {
    return transaction(this.db, () => {
      const result = add();
      this.db
        .prepare("UPDATE import_jobs SET topics=?, messages=? WHERE id=?")
        .run(counts.topics, counts.messages, id);
      return result;
    });
  }

  finish(status: ImportStatus & { state: Exclude<ImportStatus["state"], "running"> }) {
    return transaction(this.db, () => {
      const { importId, state, reason, source, topics, messages } = status;
      if (state !== "completed") {
        this.db.prepare("DELETE FROM messages WHERE import_id=?").run(importId);
        this.db.prepare("DELETE FROM conversations WHERE import_id=?").run(importId);
      }
      this.db
        .prepare("UPDATE import_jobs SET state=?,reason=? WHERE id=?")
        .run(state, reason, importId);
      const botId = this.target(importId);
      if (typeof botId !== "string") throw new Error("import_job_missing");
      this.audit.append({
        botId,
        kind: "import.changed",
        summary: "Conversation import / 对话导入",
        detail: {
          actor: reason === "interrupted" ? "automatic" : "user",
          conversationImport: { importId, source, state, topics, messages },
        },
      });
      return status;
    });
  }
}
