import type { DatabaseSync } from "node:sqlite";

export class TaskInputsRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(taskId: string, requestId: string) {
    const row = this.db
      .prepare(
        "SELECT request_id,message_id,message,state FROM task_messages WHERE task_id=? AND request_id=?",
      )
      .get(taskId, requestId);
    return row
      ? {
          id: String(row.request_id),
          messageId: String(row.message_id),
          text: String(row.message),
          delivered: row.state === "delivered",
        }
      : undefined;
  }
  insert(taskId: string, requestId: string, messageId: string, text: string) {
    this.db
      .prepare(
        `INSERT INTO task_messages(task_id,request_id,message_id,message,state,created_at) VALUES(?,?,?,?,'pending',?)`,
      )
      .run(taskId, requestId, messageId, text, new Date().toISOString());
  }
  pending(taskId: string) {
    return this.db
      .prepare(`SELECT request_id,message_id,message FROM task_messages WHERE task_id=? AND state='pending'
      ORDER BY created_at,request_id LIMIT 100`)
      .all(taskId)
      .map((row) => ({
        id: String(row.request_id),
        messageId: String(row.message_id),
        text: String(row.message),
      }));
  }
  delivered(taskId: string, requestId: string) {
    this.db
      .prepare("UPDATE task_messages SET state='delivered' WHERE task_id=? AND request_id=?")
      .run(taskId, requestId);
  }
  references(taskId: string) {
    return this.db
      .prepare(`SELECT message FROM task_messages WHERE task_id=? AND state='delivered'
      ORDER BY created_at DESC,request_id DESC LIMIT 16`)
      .all(taskId)
      .reverse()
      .map((row) => String(row.message))
      .join("\n\n")
      .slice(-8_000);
  }
}
