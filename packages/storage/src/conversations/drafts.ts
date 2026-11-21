import type { DatabaseSync } from "node:sqlite";
import {
  CapabilityIdSchema,
  CapabilityImplTypeSchema,
  DraftContentSchema,
  type DraftMetadata,
  DraftMetadataSchema,
  type DraftStatus,
  DraftStatusSchema,
  type DraftView,
  DraftViewSchema,
  IdSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { z } from "zod";
import { transaction } from "../database/database.ts";
import { readPage } from "../database/paging.ts";
import { RunEventsRepo } from "../runs/run-events.ts";

// Private execution payload, never part of Approval or an event/export view.
export const DraftPayloadSchema = z.strictObject({
  args: z.record(z.string(), z.json()),
  content: DraftContentSchema,
  contentField: z.string().nullable(),
  snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Stable capability writes re-check this selection immediately before dispatch. */
  capabilityId: CapabilityIdSchema.optional(),
  capabilityImpl: CapabilityImplTypeSchema.optional(),
  groupId: z.string().uuid().optional(),
  /** Review snapshot only, never an execution authority or a tool argument. */
  calendarPresentation: z
    .strictObject({ timeZone: z.string().min(1).max(200), name: z.string().max(512).optional() })
    .optional(),
  // Only brain stamps execution provenance; it is never accepted by a draft UI RPC.
  origin: z
    .strictObject({
      executionTaskId: IdSchema.optional(),
      taskId: IdSchema.optional(),
      threadId: IdSchema.optional(),
      cycleId: IdSchema.optional(),
      routineRunId: IdSchema.optional(),
      routineSource: z.enum(["routine", "trial"]).optional(),
      groupAuthorizationDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      operationHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      callDigest: z.string().regex(/^[a-f0-9]{64}$/),
      /** The idempotency key of the send (journal key, else the routine ledger key). */
      idempotencyKey: z
        .string()
        .regex(/^[a-f0-9]{32,64}$/)
        .optional(),
    })
    .optional(),
});
export type DraftPayload = z.output<typeof DraftPayloadSchema>;
const columns = `d.approval_id AS id,a.bot_id AS botId,a.conversation_id AS conversationId,
  d.identity,d.target,d.connector_id AS connectorId,d.content_digest AS contentDigest,
  d.content_length AS contentLength,d.edited,d.status,d.resolved_at AS resolvedAt,
  a.created_at AS createdAt,a.expires_at AS expiresAt,a.request AS request,d.payload`;
function view(row: Record<string, unknown>): DraftView {
  const request = JSON.parse(String(row.request));
  return DraftViewSchema.parse({
    approvalId: row.id,
    botId: row.botId,
    conversationId: row.conversationId,
    draft: DraftMetadataSchema.parse({
      ...request.draft,
      contentDigest: row.contentDigest,
      contentLength: row.contentLength,
    }),
    edited: row.edited === 1,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt,
  });
}
export class DraftsRepo {
  constructor(private readonly db: DatabaseSync) {}
  create(approvalId: string, metadata: DraftMetadata, payload: DraftPayload): void {
    const draft = DraftMetadataSchema.parse(metadata);
    const body = JSON.stringify(DraftPayloadSchema.parse(payload));
    if (
      Buffer.byteLength(body, "utf8") > 1048576 ||
      Buffer.byteLength(payload.content, "utf8") > 65536
    )
      throw new RpcError(RpcErrorCodes.draftContentInvalid, "draft_content_invalid");
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO send_drafts(approval_id,connector_id,identity,target,content_digest,content_length,status,payload) VALUES(?,?,?,?,?,?,'pending',?)`,
        )
        .run(
          approvalId,
          draft.connectorId,
          draft.identity,
          draft.target,
          draft.contentDigest,
          draft.contentLength,
          body,
        );
      const scope = this.scope(approvalId);
      if (scope)
        new RunEventsRepo(this.db).append({
          ...scope,
          kind: "draft.created",
          payload: {
            approvalId,
            connectorId: draft.connectorId,
            status: "pending",
            contentDigest: draft.contentDigest,
            contentLength: draft.contentLength,
          },
        });
    });
  }
  byCall(runId: string, toolCallId: string) {
    const row = this.db
      .prepare(
        "SELECT a.id FROM approvals a JOIN send_drafts d ON d.approval_id=a.id WHERE a.run_id=? AND a.tool_call_id=? LIMIT 1",
      )
      .get(runId, toolCallId);
    return row ? String(row.id) : undefined;
  }
  byOperation(runId: string, digest: string) {
    const row = this.db
      .prepare(
        "SELECT a.id FROM approvals a JOIN send_drafts d ON d.approval_id=a.id WHERE a.run_id=? AND json_extract(d.payload,'$.origin.callDigest')=? ORDER BY a.created_at,a.id LIMIT 1",
      )
      .get(runId, digest);
    return row ? String(row.id) : undefined;
  }
  uncertainTarget(runId: string, connectorId: string, tool: string, targetDigest: string) {
    return !!this.db
      .prepare(`SELECT 1 FROM send_drafts d JOIN approvals a ON a.id=d.approval_id
      WHERE a.run_id=? AND d.connector_id=? AND json_extract(a.request,'$.draft.tool')=?
      AND d.status IN ('sending','unknown','failed')
      AND (json_extract(d.payload,'$.contentField') IS NULL
        OR json_extract(d.payload,'$.targetDigest')=?) LIMIT 1`)
      .get(runId, connectorId, tool, targetDigest);
  }
  /** History cards need neither the body nor approval request metadata to display an outcome. */
  status(id: string, conversationId: string): { status: DraftStatus } | undefined {
    const row = this.db
      .prepare(`SELECT d.status FROM send_drafts d JOIN approvals a ON a.id=d.approval_id
        WHERE d.approval_id=? AND a.conversation_id=?`)
      .get(id, conversationId);
    return row ? { status: DraftStatusSchema.parse(row.status) } : undefined;
  }
  get(id: string): { view: DraftView; payload: DraftPayload } | undefined {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM send_drafts d JOIN approvals a ON a.id=d.approval_id WHERE d.approval_id=?`,
      )
      .get(id);
    return row
      ? { view: view(row), payload: DraftPayloadSchema.parse(JSON.parse(String(row.payload))) }
      : undefined;
  }
  expired(): string[] {
    return this.db
      .prepare(
        "SELECT d.approval_id AS id FROM send_drafts d JOIN approvals a ON a.id=d.approval_id WHERE d.status='pending' AND a.expires_at<=? ORDER BY a.expires_at,d.approval_id LIMIT 200",
      )
      .all(new Date().toISOString())
      .map((row) => String(row.id));
  }
  list(query: { before?: string; limit?: number; botId?: string } = {}): DraftView[] {
    const scope: [string, string][] = query.botId ? [["botId", query.botId]] : [];
    return readPage(
      this.db,
      `(SELECT ${columns} FROM send_drafts d JOIN approvals a ON a.id=d.approval_id WHERE a.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      "*",
      "createdAt",
      { before: query.before, limit: query.limit },
      [...scope, ["status", "pending"]],
      scope,
    ).map(view);
  }
  claim(
    id: string,
    action: "send" | "discard",
    content: string,
    digest: string,
    edited: boolean,
  ): void {
    transaction(this.db, () => {
      const current = this.get(id);
      if (!current) throw new RpcError(RpcErrorCodes.draftUnavailable, "draft_unavailable");
      if (current.view.status !== "pending")
        throw new RpcError(RpcErrorCodes.draftResolved, "draft_already_resolved");
      const payload = { ...current.payload, content };
      const changed = this.db
        .prepare(
          `UPDATE send_drafts SET status=?,content_digest=?,content_length=?,edited=?,payload=?,resolved_at=? WHERE approval_id=? AND status='pending'`,
        )
        .run(
          action === "send" ? "sending" : "discarded",
          digest,
          Buffer.byteLength(content, "utf8"),
          Number(edited),
          JSON.stringify(payload),
          new Date().toISOString(),
          id,
        ).changes;
      if (!changed) throw new RpcError(RpcErrorCodes.draftResolved, "draft_already_resolved");
      const scope = this.scope(id);
      if (scope)
        new RunEventsRepo(this.db).append({
          ...scope,
          kind: "draft.status",
          payload: { approvalId: id, status: action === "send" ? "sending" : "discarded", edited },
        });
    });
  }
  beginDispatch(id: string): void {
    transaction(this.db, () => {
      if (
        !this.db
          .prepare(
            "UPDATE send_drafts SET dispatch_started=1 WHERE approval_id=? AND status='sending' AND dispatch_started=0",
          )
          .run(id).changes
      )
        throw new RpcError(RpcErrorCodes.draftResolved, "draft_already_dispatched");
      const scope = this.scope(id);
      if (scope)
        new RunEventsRepo(this.db).append({
          ...scope,
          kind: "draft.dispatch_started",
          payload: { approvalId: id },
        });
    });
  }
  finish(id: string, status: DraftStatus): void {
    DraftStatusSchema.parse(status);
    transaction(this.db, () => {
      const at = new Date().toISOString();
      const changed = this.db
        .prepare(
          "UPDATE send_drafts SET status=?,resolved_at=? WHERE approval_id=? AND status IN ('pending','sending')",
        )
        .run(status, at, id).changes;
      const scope = changed ? this.scope(id) : undefined;
      if (scope)
        new RunEventsRepo(this.db).append({
          ...scope,
          kind: "draft.status",
          at,
          payload: { approvalId: id, status },
        });
    });
  }
  recover(): void {
    // No exactly-once guarantee across an external service and SQLite. Never retry uncertain sends.
    transaction(this.db, () => {
      const before = this.db
        .prepare(`SELECT d.approval_id AS id,d.status,a.run_id AS runId,
          a.conversation_id AS conversationId,a.status AS approvalStatus
          FROM send_drafts d JOIN approvals a ON a.id=d.approval_id
          WHERE d.status IN ('pending','sending')`)
        .all();
      this.db.exec(`UPDATE send_drafts SET status='unknown',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='sending';
      UPDATE approvals SET status='allowed',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='pending' AND id IN (SELECT approval_id FROM send_drafts WHERE status='unknown');
      UPDATE send_drafts SET status='expired',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='pending' AND approval_id IN (SELECT id FROM approvals WHERE status<>'pending' OR expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      UPDATE approvals SET status='expired',resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='pending' AND id IN (SELECT approval_id FROM send_drafts WHERE status='expired')`);
      const events = new RunEventsRepo(this.db);
      for (const row of before) {
        const current = this.db
          .prepare(`SELECT d.status,a.status AS approvalStatus FROM send_drafts d
            JOIN approvals a ON a.id=d.approval_id WHERE d.approval_id=?`)
          .get(String(row.id));
        if (current?.status !== row.status)
          events.append({
            runId: String(row.runId),
            conversationId: String(row.conversationId),
            kind: "draft.status",
            payload: { approvalId: String(row.id), status: current?.status, recovered: true },
          });
        if (current?.approvalStatus !== row.approvalStatus)
          events.append({
            runId: String(row.runId),
            conversationId: String(row.conversationId),
            kind: "approval.resolved",
            payload: {
              approvalId: String(row.id),
              status: current?.approvalStatus,
              remembered: false,
              recovered: true,
            },
          });
      }
    });
  }

  private scope(approvalId: string): { runId: string; conversationId: string } | undefined {
    const row = this.db
      .prepare("SELECT run_id AS runId,conversation_id AS conversationId FROM approvals WHERE id=?")
      .get(approvalId);
    return row
      ? { runId: String(row.runId), conversationId: String(row.conversationId) }
      : undefined;
  }
}
