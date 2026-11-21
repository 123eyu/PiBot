import type { DatabaseSync } from "node:sqlite";
import { type ChatAddition, chatAddition, type Message } from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { MessagesRepo } from "../workspace/repositories.ts";

export class ChatAdditionsRepo {
  private readonly messages: MessagesRepo;
  constructor(private readonly db: DatabaseSync) {
    this.messages = new MessagesRepo(db);
  }
  get(requestId: string) {
    const message = this.messages.get(requestId);
    return message && chatAddition(message) ? message : undefined;
  }
  pending(runId: string) {
    return Number(
      this.db
        .prepare(`SELECT count(*) AS n FROM messages WHERE run_id=?
      AND json_extract(usage,'$.chatAddition.state') IN ('queued','received')`)
        .get(runId)?.n ?? 0,
    );
  }
  hasApproval(runId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM approvals WHERE run_id=? AND status='pending' LIMIT 1")
      .get(runId);
  }
  state(requestId: string, state: ChatAddition["state"]): Message | undefined {
    const message = this.get(requestId);
    if (!message) return;
    const addition = chatAddition(message) as ChatAddition;
    if (["processed", "interrupted", "unsent"].includes(addition.state)) return message;
    const usage =
      message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
        ? message.usage
        : {};
    this.messages.update(message.id, { usage: { ...usage, chatAddition: { ...addition, state } } });
    return this.messages.get(message.id);
  }
  /** Records a new mode for a still-queued addition; anything else is returned unchanged. */
  mode(requestId: string, mode: ChatAddition["mode"]): Message | undefined {
    const message = this.get(requestId);
    if (!message) return;
    const addition = chatAddition(message) as ChatAddition;
    if (addition.state !== "queued") return message;
    const usage =
      message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
        ? message.usage
        : {};
    this.messages.update(message.id, { usage: { ...usage, chatAddition: { ...addition, mode } } });
    return this.messages.get(message.id);
  }
  finish(runId: string, completed: boolean): Message[] {
    return transaction(this.db, () => {
      const rows = this.db
        .prepare(`SELECT id FROM messages WHERE run_id=?
        AND json_extract(usage,'$.chatAddition.state') IN ('queued','received') LIMIT 16`)
        .all(runId);
      return rows.flatMap((row) => {
        const message = this.get(String(row.id));
        if (!message) return [];
        const was = chatAddition(message)?.state;
        // Never taken into the run: the model did not see it, so the user can simply send it again.
        const state =
          was === "queued"
            ? "unsent"
            : completed && was === "received"
              ? "processed"
              : "interrupted";
        const updated = this.state(message.id, state);
        return updated ? [updated] : [];
      });
    });
  }
  recover() {
    // Neither an admitted queue nor an uncertain JSONL boundary can be replayed after a crash.
    transaction(this.db, () => {
      this.db
        .prepare(`UPDATE messages SET usage=json_set(usage,'$.chatAddition.state','interrupted'), updated_at=?
        WHERE json_extract(usage,'$.chatAddition.state') IN ('queued','received')`)
        .run(new Date().toISOString());
      this.db
        .prepare(`UPDATE messages SET status='aborted',error_code='aborted',updated_at=?
        WHERE status='streaming' AND json_extract(usage,'$.chatSegment')=1`)
        .run(new Date().toISOString());
    });
  }
}
