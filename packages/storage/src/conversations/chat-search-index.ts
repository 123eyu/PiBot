import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../database/database.ts";

export const CHAT_SEARCH_BATCH_SIZE = 128;
const BATCH_WORK_MS = 12;
const MAX_BODY_BYTES = 256 * 1024;

/** A NULL body queues only the identity until the writer's credential redactor is ready. */
export function configureChatSearchRedactor(
  db: DatabaseSync,
  redact: (text: string) => string | null = () => null,
) {
  db.function("pibot_chat_search_redact", (value) => {
    if (typeof value !== "string" || Buffer.byteLength(value) > MAX_BODY_BYTES) return "";
    const body = redact(value);
    if (body === null) return null;
    // Never slice raw input before redaction; a cut credential might no longer be recognizable.
    return Buffer.byteLength(body) <= MAX_BODY_BYTES ? body.replaceAll("\0", " ") : "";
  });
}

export class ChatSearchIndex {
  constructor(private readonly db: DatabaseSync) {}

  backfillBatch(signal: AbortSignal): { done: boolean; scanned: number } {
    signal.throwIfAborted();
    return transaction(this.db, () => {
      const state = this.db
        .prepare("SELECT after_id,through_id FROM chat_search_backfill WHERE id=1")
        .get();
      if (!state) return this.drainPending(signal);
      const rows = this.db
        .prepare("SELECT id FROM messages WHERE id>? AND id<=? ORDER BY id LIMIT ?")
        .all(String(state.after_id), String(state.through_id), CHAT_SEARCH_BATCH_SIZE);
      const insert =
        this.db.prepare(`INSERT INTO chat_search_documents(message_id,scope,body,created_at)
        SELECT id,scope,pibot_chat_search_redact(content),created_at FROM chat_search_source
        WHERE id=? AND NOT EXISTS(SELECT 1 FROM chat_search_documents WHERE message_id=?)`);
      const start = performance.now();
      let scanned = 0;
      for (const { id } of rows) {
        signal.throwIfAborted();
        insert.run(String(id), String(id));
        scanned++;
        if (performance.now() - start >= BATCH_WORK_MS) break;
      }
      signal.throwIfAborted();
      if (scanned === rows.length && rows.length < CHAT_SEARCH_BATCH_SIZE)
        this.db.exec("DELETE FROM chat_search_backfill WHERE id=1");
      else
        this.db
          .prepare("UPDATE chat_search_backfill SET after_id=? WHERE id=1")
          .run(String(rows[scanned - 1]?.id ?? state.after_id));
      return { done: false, scanned };
    });
  }

  private drainPending(signal: AbortSignal) {
    const rows = this.db
      .prepare(
        "SELECT message_id FROM chat_search_documents WHERE body IS NULL ORDER BY message_id LIMIT ?",
      )
      .all(CHAT_SEARCH_BATCH_SIZE);
    const update = this.db.prepare(`UPDATE chat_search_documents
      SET body=CASE WHEN EXISTS(SELECT 1 FROM chat_search_source WHERE id=?)
        THEN (SELECT pibot_chat_search_redact(content) FROM chat_search_source WHERE id=?) ELSE '' END
      WHERE message_id=? AND body IS NULL`);
    const start = performance.now();
    let scanned = 0;
    for (const { message_id } of rows) {
      signal.throwIfAborted();
      const id = String(message_id);
      update.run(id, id, id);
      scanned++;
      if (performance.now() - start >= BATCH_WORK_MS) break;
    }
    signal.throwIfAborted();
    return { done: scanned === rows.length && rows.length < CHAT_SEARCH_BATCH_SIZE, scanned };
  }

  pending(): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM chat_search_backfill
      UNION ALL SELECT 1 FROM chat_search_documents WHERE body IS NULL LIMIT 1`)
      .get();
  }
}
