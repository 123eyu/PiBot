import type { DatabaseSync } from "node:sqlite";
import {
  type MethodParams,
  type MethodResults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/office-contract/full";
import { BotsRepo, ConversationsRepo, MessagesRepo, RunsRepo } from "@pibot/storage";

type Key = MethodParams["office.renderStep"];
type Report = NonNullable<MethodResults["office.renderStep"]>;
type Summary = Omit<Report, "pages">;
const keyOf = ({ runId, messageId, toolCallId }: Key) =>
  JSON.stringify([runId, messageId, toolCallId]);
/** The check summary is tiny and worth keeping; a month is far beyond browsing old chats. */
const RETENTION_MS = 30 * 24 * 60 * 60_000;

export class RenderReports {
  private readonly entries = new Map<
    string,
    { report: Report; revision: string; botId: string; size: number; expires: number }
  >();
  private size = 0;
  private readonly timer = setInterval(() => this.prune(), 30_000).unref();
  private stopped = false;
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  put(key: Key, report: Report, revision: string, botId: string) {
    if (this.stopped) return;
    const id = keyOf(key);
    const size = report.pages.reduce((sum, page) => sum + page.data.length, 0);
    this.remove(id);
    this.entries.set(id, { report, revision, botId, size, expires: Date.now() + 10 * 60_000 });
    this.size += size;
    this.save(key, report, revision, botId);
    this.prune();
  }
  step(key: Key) {
    // The images expire with the process, but the check list belongs to the message, so an old
    // step still shows what was wrong instead of "expired".
    return this.get(key)?.report ?? this.stored(key);
  }
  snapshot(input: MethodParams["office.renderSnapshot"]): MethodResults["office.renderSnapshot"] {
    const entry = this.get(input);
    const page = entry?.report.pages.find((item) => item.page === input.page);
    if (!entry || !page) throw new RpcError(RpcErrorCodes.invalidParams, "office_render_expired");
    return { kind: "image", data: page.data, revision: entry.revision };
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.entries.clear();
    this.size = 0;
  }
  private remove(id: string) {
    const entry = this.entries.get(id);
    if (entry && this.entries.delete(id)) this.size -= entry.size;
  }
  private prune() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expires > now && this.size <= 24 * 1024 * 1024 && this.entries.size <= 32) break;
      this.remove(id);
    }
  }
  private get(key: Key) {
    this.prune();
    const entry = this.entries.get(keyOf(key));
    if (!entry) return;
    if (!this.authorized(key, entry.botId)) return;
    return entry;
  }
  /** Same authorization as the live path: the step must belong to this run's assistant message. */
  private authorized(key: Key, botId: string) {
    const run = new RunsRepo(this.db).get(key.runId);
    const message = new MessagesRepo(this.db).get(key.messageId);
    if (
      !run ||
      run.botId !== botId ||
      run.messageId !== key.messageId ||
      message?.role !== "assistant" ||
      message.conversationId !== run.conversationId ||
      new ConversationsRepo(this.db).isInternal(message.conversationId) ||
      !new BotsRepo(this.db).get(botId)
    )
      return false;
    return true;
  }
  private save(key: Key, report: Report, revision: string, botId: string) {
    const summary: Summary = {
      name: report.name,
      format: report.format,
      status: report.status,
      check: report.check,
    };
    this.db
      .prepare(
        `INSERT INTO office_render_checks (run_id, message_id, tool_call_id, bot_id, summary, revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, message_id, tool_call_id) DO UPDATE SET
           bot_id=excluded.bot_id, summary=excluded.summary, revision=excluded.revision,
           created_at=excluded.created_at`,
      )
      .run(
        key.runId,
        key.messageId,
        key.toolCallId,
        botId,
        JSON.stringify(summary),
        revision,
        new Date().toISOString(),
      );
    this.db
      .prepare("DELETE FROM office_render_checks WHERE created_at < ?")
      .run(new Date(Date.now() - RETENTION_MS).toISOString());
  }
  private stored(key: Key): Report | null {
    const row = this.db
      .prepare(
        "SELECT bot_id AS botId, summary FROM office_render_checks WHERE run_id = ? AND message_id = ? AND tool_call_id = ?",
      )
      .get(key.runId, key.messageId, key.toolCallId);
    if (!row || !this.authorized(key, String(row.botId))) return null;
    try {
      const summary = JSON.parse(String(row.summary)) as Summary;
      return { ...summary, pages: [], imagesExpired: true };
    } catch {
      // A row we cannot read is no better than an expired one; the step falls back to its notice.
      return null;
    }
  }
}
