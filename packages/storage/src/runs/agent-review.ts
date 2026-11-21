import type { DatabaseSync } from "node:sqlite";
import {
  type DeliveryEvidence,
  DeliveryEvidenceSchema,
  IdSchema,
  ReviewFindingSchema,
  type ReviewSummary,
  ReviewSummarySchema,
} from "@pibot/protocol-base";
import { z } from "zod";
import { ManagedIdentitySchema } from "../workspace/managed-worktrees.ts";

export const ReviewSourceSchema = z.strictObject({
  worktreeReview: z
    .strictObject({
      rootId: IdSchema,
      source: ManagedIdentitySchema,
      root: ManagedIdentitySchema,
      git: ManagedIdentitySchema,
      common: ManagedIdentitySchema,
      gitPointer: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    })
    .optional(),
  botId: IdSchema,
  conversationId: IdSchema,
  runId: IdSchema,
  messageId: IdSchema,
  groupId: IdSchema.optional(),
  threadId: IdSchema.optional(),
  groupAuthorization: z.string().max(200_000).optional(),
  taskId: IdSchema.optional(),
  cycleId: IdSchema.optional(),
});
export type ReviewSource = z.infer<typeof ReviewSourceSchema>;
export interface ReviewExecutionRecord {
  summary: ReviewSummary;
  source: ReviewSource;
  root: string;
  bytes: number;
}
const scopeWhere = "bot_id=? AND conversation_id=?";
type Scope = { botId: string; conversationId: string };
type Page = { before?: string; limit?: number; rootId?: string };
export class ReviewExecutionsRepo {
  constructor(private readonly db: DatabaseSync) {}
  private parse(row: Record<string, unknown>): ReviewExecutionRecord {
    return {
      summary: ReviewSummarySchema.parse(JSON.parse(String(row.summary_json))),
      source: ReviewSourceSchema.parse(JSON.parse(String(row.source_json))),
      root: String(row.root),
      bytes: Number(row.snapshot_bytes),
    };
  }
  get(id: string) {
    const row = this.db.prepare("SELECT * FROM review_executions WHERE id=?").get(id);
    return row ? this.parse(row) : undefined;
  }
  latestForFolder(scope: {
    botId: string;
    conversationId?: string;
    groupId?: string;
    root: string;
  }) {
    const where = scope.groupId
      ? "json_extract(source_json,'$.groupId')=?"
      : "bot_id=? AND json_extract(source_json,'$.groupId') IS NULL";
    const row = this.db
      .prepare(`SELECT * FROM review_executions WHERE ${where} AND root=?
      ${scope.conversationId ? "AND conversation_id=?" : ""}
      AND (json_extract(summary_json,'$.status')='done' OR json_extract(summary_json,'$.findingsCount')>0)
      ORDER BY created_at DESC,id DESC LIMIT 1`)
      .get(
        scope.groupId ?? scope.botId,
        scope.root,
        ...(scope.conversationId ? [scope.conversationId] : []),
      );
    return row ? this.parse(row) : undefined;
  }
  forRun(runId: string) {
    const row = this.db
      .prepare(
        "SELECT r.* FROM review_executions r JOIN task_attempts a ON a.task_id=r.task_id WHERE a.run_id=? LIMIT 1",
      )
      .get(IdSchema.parse(runId));
    return row ? this.parse(row) : undefined;
  }
  forTask(id: string) {
    const row = this.db.prepare("SELECT * FROM review_executions WHERE task_id=?").get(id);
    return row ? this.parse(row) : undefined;
  }
  findings(id: string) {
    const record = this.get(id);
    if (!record?.summary.taskId) return { findings: [], truncated: false };
    const rows = this.db
      .prepare(
        "SELECT f.id,f.run_id AS runId,f.path,f.line,f.end_line AS endLine,f.severity,f.message,f.state,f.created_at AS createdAt FROM review_findings f JOIN task_attempts a ON a.run_id=f.run_id WHERE a.task_id=? AND f.bot_id=? AND f.conversation_id=? AND f.root=? ORDER BY f.created_at,f.id LIMIT 201",
      )
      .all(record.summary.taskId, record.summary.botId, record.summary.conversationId, record.root);
    return {
      findings: rows.slice(0, 200).map((row) => ReviewFindingSchema.parse(row)),
      truncated: rows.length > 200,
    };
  }
  duplicate(runId: string, callId: string) {
    const row = this.db
      .prepare("SELECT * FROM review_executions WHERE parent_run_id=? AND tool_call_id=?")
      .get(runId, callId);
    return row ? this.parse(row) : undefined;
  }
  create(record: ReviewExecutionRecord, callId: string) {
    const { summary: s, source, root, bytes } = record;
    ReviewSummarySchema.parse(s);
    ReviewSourceSchema.parse(source);
    this.db
      .prepare(
        "INSERT INTO review_executions(id,bot_id,conversation_id,parent_run_id,tool_call_id,task_id,summary_json,source_json,root,snapshot_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        s.id,
        s.botId,
        s.conversationId,
        s.parentRunId,
        callId,
        s.taskId,
        JSON.stringify(s),
        JSON.stringify(source),
        root,
        bytes,
        s.createdAt,
      );
  }
  save(summary: ReviewSummary) {
    const s = ReviewSummarySchema.parse(summary);
    this.db
      .prepare("UPDATE review_executions SET summary_json=?,task_id=? WHERE id=?")
      .run(JSON.stringify(s), s.taskId, s.id);
  }
  list(scope: Scope, page: Page = {}) {
    const limit = Math.min(page.limit ?? 20, 50),
      cursor = page.before ? this.get(page.before) : undefined;
    if (
      page.before &&
      (!cursor ||
        cursor.summary.botId !== scope.botId ||
        cursor.summary.conversationId !== scope.conversationId ||
        (page.rootId !== undefined && cursor.summary.rootId !== page.rootId))
    )
      return [];
    return this.db
      .prepare(
        `SELECT * FROM review_executions WHERE ${scopeWhere}${page.rootId ? " AND json_extract(summary_json,'$.rootId')=?" : ""}${cursor ? " AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(
        scope.botId,
        scope.conversationId,
        ...(page.rootId ? [page.rootId] : []),
        ...(cursor ? [cursor.summary.createdAt, cursor.summary.createdAt, cursor.summary.id] : []),
        limit,
      )
      .map((r) => this.parse(r));
  }
  usage() {
    return Number(
      this.db
        .prepare("SELECT COALESCE(sum(snapshot_bytes),0) AS bytes FROM review_executions")
        .get()?.bytes ?? 0,
    );
  }
  expire(id: string) {
    this.db.prepare("UPDATE review_executions SET snapshot_bytes=0 WHERE id=?").run(id);
  }
  expired(before: string) {
    return this.db
      .prepare(
        "SELECT * FROM review_executions WHERE created_at<? AND snapshot_bytes>0 AND json_extract(summary_json,'$.status') IN ('done','error','aborted','interrupted') ORDER BY created_at LIMIT 100",
      )
      .all(before)
      .map((r) => this.parse(r));
  }
  recover() {
    const rows = this.db
      .prepare(
        "SELECT * FROM review_executions WHERE json_extract(summary_json,'$.status') IN ('capturing','queued','running')",
      )
      .all();
    for (const row of rows) {
      const { summary } = this.parse(row);
      this.save({
        ...summary,
        status: "interrupted",
        freshness: "checking",
        updatedAt: new Date().toISOString(),
      });
    }
  }
}
export class DeliveryEvidenceRepo {
  constructor(private readonly db: DatabaseSync) {}
  toolRun(id: string) {
    const row = this.db
      .prepare(
        "SELECT m.run_id AS runId,COALESCE(m.bot_id,c.bot_id) AS botId,m.conversation_id AS conversationId FROM tool_calls t JOIN messages m ON m.id=t.message_id JOIN conversations c ON c.id=m.conversation_id WHERE t.id=?",
      )
      .get(id);
    return row?.runId
      ? {
          runId: String(row.runId),
          botId: String(row.botId),
          conversationId: row.conversationId === null ? null : String(row.conversationId),
        }
      : undefined;
  }
  get(id: string) {
    const row = this.db.prepare("SELECT payload_json FROM delivery_evidence WHERE id=?").get(id);
    return row ? DeliveryEvidenceSchema.parse(JSON.parse(String(row.payload_json))) : undefined;
  }
  create(value: DeliveryEvidence, sourceId: string) {
    const e = DeliveryEvidenceSchema.parse(value);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO delivery_evidence(id,bot_id,conversation_id,root_run_id,run_id,kind,source_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        e.id,
        e.botId,
        e.conversationId,
        e.rootRunId,
        e.runId,
        e.kind,
        sourceId,
        JSON.stringify(e),
        e.createdAt,
      );
    const row = this.db
      .prepare("SELECT id FROM delivery_evidence WHERE root_run_id=? AND kind=? AND source_id=?")
      .get(e.rootRunId, e.kind, sourceId);
    const existing = this.get(String(row?.id)) as DeliveryEvidence;
    // A handoff may acquire its screenshot after its first step receipt was recorded.
    if (
      e.kind === "screenshot" &&
      existing.kind === "screenshot" &&
      e.available &&
      !existing.available
    ) {
      const updated = { ...existing, available: true };
      this.db
        .prepare("UPDATE delivery_evidence SET payload_json=? WHERE id=?")
        .run(JSON.stringify(updated), existing.id);
      return updated;
    }
    return existing;
  }
  list(scope: Scope, page: Page = {}) {
    const cursor = page.before ? this.get(page.before) : undefined;
    if (
      page.before &&
      (!cursor || cursor.botId !== scope.botId || cursor.conversationId !== scope.conversationId)
    )
      return [];
    return this.db
      .prepare(
        `SELECT payload_json FROM delivery_evidence WHERE ${scopeWhere}${cursor ? " AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(
        scope.botId,
        scope.conversationId,
        ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
        Math.min(page.limit ?? 20, 50),
      )
      .map((r) => DeliveryEvidenceSchema.parse(JSON.parse(String(r.payload_json))));
  }
}
