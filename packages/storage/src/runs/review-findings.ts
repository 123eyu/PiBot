import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  IdSchema,
  type ReviewFinding,
  ReviewFindingSchema,
  type ReviewFindingStateSchema,
} from "@pibot/protocol-base";
import type { z } from "zod";

/** A runaway review cannot grow the table (or the sidebar) without bound. */
export const REVIEW_FINDINGS_PER_RUN = 200;
/** How recent a finished run must be for a just-accepted review request to bind to it. */
const START_WINDOW_MS = 10 * 60 * 1000;
const runColumns = "id,bot_id AS botId,group_id AS groupId,conversation_id AS conversationId";
const columns =
  "id,run_id AS runId,path,line,end_line AS endLine,severity,message,state,created_at AS createdAt";

export interface ReviewOwner {
  botId: string;
  groupId?: string;
  conversationId?: string;
}

/** Conversation filter mirrors RunFileChangesRepo.latestRun: group, then DM conversation, then Bot. */
function owner(target: ReviewOwner): [string, string] {
  if (target.groupId) return ["group_id=?", IdSchema.parse(target.groupId)];
  if (target.conversationId)
    return ["conversation_id=? AND group_id IS NULL", IdSchema.parse(target.conversationId)];
  return ["bot_id=? AND group_id IS NULL", IdSchema.parse(target.botId)];
}

export class ReviewFindingsRepo {
  constructor(private readonly db: DatabaseSync) {}
  /** Returns undefined once the run reached its cap; the tool then tells the Bot to stop. */
  record(
    input: ReviewOwner & {
      runId: string;
      root: string;
      path: string;
      line: number | null;
      endLine: number | null;
      severity: ReviewFinding["severity"];
      message: string;
    },
  ): ReviewFinding | undefined {
    const finding = ReviewFindingSchema.parse({
      id: randomUUID(),
      runId: input.runId,
      path: input.path,
      line: input.line,
      endLine: input.endLine,
      severity: input.severity,
      message: input.message,
      state: "open",
      createdAt: new Date().toISOString(),
    });
    const used = Number(
      this.db.prepare("SELECT count(*) AS n FROM review_findings WHERE run_id=?").get(finding.runId)
        ?.n ?? 0,
    );
    if (used >= REVIEW_FINDINGS_PER_RUN) return undefined;
    this.db
      .prepare(
        "INSERT INTO review_findings(id,run_id,bot_id,group_id,conversation_id,root,path,line,end_line,severity,message,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        finding.id,
        finding.runId,
        IdSchema.parse(input.botId),
        input.groupId ?? null,
        input.conversationId ?? null,
        input.root,
        finding.path,
        finding.line,
        finding.endLine,
        finding.severity,
        finding.message,
        finding.state,
        finding.createdAt,
      );
    return finding;
  }
  /**
   * Registers a review the user just asked for. It binds to the run the request went to: the
   * newest run of this conversation (the new run, or the running one a follow-up joined); in a
   * group, every reply to that user message. Idempotent per run and folder.
   */
  start(target: ReviewOwner & { root: string }): string[] {
    const [where, value] = owner(target);
    const run = this.db
      .prepare(
        `SELECT id,group_id AS groupId,user_message_id AS userMessageId,status,created_at AS createdAt FROM runs WHERE ${where} ORDER BY created_at DESC,rowid DESC LIMIT 1`,
      )
      .get(value);
    if (!run) return [];
    const active = ["queued", "running", "waiting"].includes(String(run.status));
    // The request was accepted moments ago; an old finished run means it did not start one here.
    if (!active && Date.now() - Date.parse(String(run.createdAt)) > START_WINDOW_MS) return [];
    const rows =
      run.groupId && run.userMessageId
        ? this.db
            .prepare(
              `SELECT ${runColumns} FROM runs WHERE group_id=? AND user_message_id=? ORDER BY created_at LIMIT 6`,
            )
            .all(String(run.groupId), String(run.userMessageId))
        : this.db.prepare(`SELECT ${runColumns} FROM runs WHERE id=?`).all(String(run.id));
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO review_runs(run_id,bot_id,group_id,conversation_id,root,created_at) VALUES (?,?,?,?,?,?)",
    );
    const at = new Date().toISOString();
    for (const row of rows)
      insert.run(
        IdSchema.parse(row.id),
        IdSchema.parse(row.botId),
        row.groupId === null ? null : IdSchema.parse(row.groupId),
        row.conversationId === null ? null : IdSchema.parse(row.conversationId),
        target.root,
        at,
      );
    return rows.map((row) => String(row.id));
  }
  /**
   * Findings of the newest review in this conversation for one folder. A review counts once it
   * recorded a finding, or once its registered run completed, so a clean review (no findings)
   * replaces the previous one. A registered review that is still running, was aborted or failed
   * without findings leaves the previous findings showing.
   */
  latest(target: ReviewOwner & { root: string }) {
    const [where, value] = owner(target);
    const found = this.db
      .prepare(
        `SELECT run_id AS runId,created_at AS at FROM review_findings WHERE ${where} AND root=? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(value, target.root);
    const completed = this.db
      .prepare(
        `SELECT run_id AS runId,created_at AS at FROM review_runs WHERE ${where} AND root=? AND EXISTS (SELECT 1 FROM runs WHERE runs.id=review_runs.run_id AND runs.status='done') ORDER BY created_at DESC LIMIT 1`,
      )
      .get(value, target.root);
    // A run's findings are newer than its registration, so a completed review registered after
    // another run's newest finding recorded none of its own.
    const newest =
      completed && (!found || String(completed.at) > String(found.at)) ? completed : found;
    if (!newest) return { runId: null, findings: [] as ReviewFinding[] };
    const runId = String(newest.runId);
    const findings = this.db
      .prepare(
        `SELECT ${columns} FROM review_findings WHERE run_id=? AND root=? ORDER BY path,line,rowid LIMIT ?`,
      )
      .all(runId, target.root, REVIEW_FINDINGS_PER_RUN)
      .map((item) => ReviewFindingSchema.parse(item));
    return { runId, findings };
  }
  /** Only findings of this conversation and folder change; ids from elsewhere are ignored. */
  setState(
    target: ReviewOwner & { root: string },
    ids: readonly string[],
    state: z.infer<typeof ReviewFindingStateSchema>,
  ) {
    const [where, value] = owner(target);
    const update = this.db.prepare(
      `UPDATE review_findings SET state=? WHERE id=? AND root=? AND ${where}`,
    );
    let changed = 0;
    for (const id of ids)
      changed += Number(update.run(state, IdSchema.parse(id), target.root, value).changes);
    return changed;
  }
  expire(before: string, limit = 5000) {
    this.db
      .prepare(
        "DELETE FROM review_runs WHERE rowid IN (SELECT rowid FROM review_runs WHERE created_at < ? LIMIT ?)",
      )
      .run(before, limit);
    return Number(
      this.db
        .prepare(
          "DELETE FROM review_findings WHERE id IN (SELECT id FROM review_findings WHERE created_at < ? LIMIT ?)",
        )
        .run(before, limit).changes,
    );
  }
}
