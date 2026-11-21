import type { DatabaseSync } from "node:sqlite";
import {
  type ConnectionUse,
  ConnectionUseCursorSchema,
  ConnectionUseSchema,
  IdSchema,
} from "@pibot/plugins-contract/full";

/**
 * Read-only view of what a connection was used for, built from records other parts of
 * the app already write: the audit log (reads and refusals of `connector_call` and app adapter
 * reads) and send drafts (writes). No table here is written. Rows carry facts only: tool names,
 * outcome codes and the Bot / group that made the call, never arguments, results or content.
 */
// Same expression as the 0097 index, so SQLite searches that index by connection and time.
const connectorKey = `COALESCE(json_extract(a.detail, '$.connectorId'),
    CASE WHEN substr(json_extract(a.detail, '$.toolId'), 1, 4) = 'mcp:'
      THEN substr(json_extract(a.detail, '$.toolId'), 5, 36) END)`;
const indexed = `a.kind IN ('connector.called', 'policy.denied') AND ${connectorKey} = ?`;
const REASON = /^[a-z][a-z0-9_]{0,79}$/;

type Cursor = { at: string; id: string } | undefined;
function parseCursor(value: string | undefined): Cursor {
  if (!value) return undefined;
  const [at = "", id = ""] = ConnectionUseCursorSchema.parse(value).split("~");
  return { at, id: IdSchema.parse(id) };
}
const reason = (value: unknown) => (typeof value === "string" && REASON.test(value) ? value : null);
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

export class ConnectionActivityRepo {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Newest first, keyset paged over two sources merged by (time, id). Each source returns at most
   * `limit + 1` rows: audit rows walk the 0097 index in order; drafts are found by
   * `send_drafts_connector` and sorted (a connection's confirmed writes are few).
   */
  recent(
    connectorId: string,
    input: { before?: string; limit: number },
    readOnlyTools: ReadonlySet<string>,
  ) {
    const id = IdSchema.parse(connectorId);
    const cursor = parseCursor(input.before);
    const limit = input.limit;
    const merged = [
      ...this.calls(id, cursor, limit + 1, readOnlyTools),
      ...this.drafts(id, cursor, limit + 1),
    ]
      .sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)))
      .slice(0, limit + 1);
    const items = merged.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map((item) => ConnectionUseSchema.parse(item)),
      nextCursor: merged.length > limit && last ? `${last.at}~${last.id}` : null,
    };
  }

  /** Last call that reached the service, and the last write actually sent. */
  lastUse(connectorId: string) {
    const id = IdSchema.parse(connectorId);
    const call = this.db
      .prepare(`SELECT a.at FROM audit_log a WHERE ${indexed} AND a.kind = 'connector.called'
      AND json_extract(a.detail, '$.toolCallId') IS NOT NULL ORDER BY a.at DESC, a.id DESC LIMIT 1`)
      .get(id);
    // Trigger reads: GitHub notification polls (older installs) and routine trigger checks.
    const poll = this.db
      .prepare(`SELECT a.at FROM audit_log a WHERE ${indexed} AND a.kind = 'connector.called'
      AND json_extract(a.detail, '$.reason') IN ('github_poll','routine_trigger')
      ORDER BY a.at DESC, a.id DESC LIMIT 1`)
      .get(id);
    const sent = this.db
      .prepare(
        "SELECT MAX(resolved_at) AS at FROM send_drafts WHERE connector_id = ? AND status = 'sent'",
      )
      .get(id);
    const at = (row: Record<string, unknown> | undefined) =>
      typeof row?.at === "string" ? row.at : null;
    return { call: at(call), poll: at(poll), sent: at(sent) };
  }

  private calls(id: string, cursor: Cursor, limit: number, readOnlyTools: ReadonlySet<string>) {
    // A read writes a `running` row and then its outcome; the running row stands for the call
    // only while no outcome exists (still running, or cut off by a restart).
    const rows = this.db
      .prepare(`SELECT a.id, a.at, a.bot_id, a.run_id, a.kind,
        json_extract(a.detail, '$.reasonCode') AS reason_code,
        COALESCE(json_extract(a.detail, '$.target'), json_extract(a.detail, '$.toolName')) AS tool,
        COALESCE(r.group_id, json_extract(a.detail, '$.groupId')) AS group_id,
        b.name AS bot_name, g.name AS group_name
      FROM audit_log a
      LEFT JOIN runs r ON r.id = a.run_id
      LEFT JOIN bots b ON b.id = a.bot_id
      LEFT JOIN groups g ON g.id = COALESCE(r.group_id, json_extract(a.detail, '$.groupId'))
      WHERE ${indexed} AND json_extract(a.detail, '$.toolCallId') IS NOT NULL
        ${cursor ? "AND (a.at < ? OR (a.at = ? AND a.id < ?))" : ""}
        AND NOT (a.kind = 'connector.called'
          AND json_extract(a.detail, '$.reasonCode') = 'connector_call_running'
          AND EXISTS (SELECT 1 FROM audit_log o WHERE o.run_id = a.run_id
            AND o.kind = 'connector.called' AND o.id <> a.id
            AND json_extract(o.detail, '$.toolCallId') = json_extract(a.detail, '$.toolCallId')
            AND json_extract(o.detail, '$.reasonCode') <> 'connector_call_running'))
      ORDER BY a.at DESC, a.id DESC LIMIT ?`)
      .all(id, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []), limit);
    return rows.map((row): ConnectionUse => {
      const code = reason(row.reason_code);
      const tool = text(row.tool, 200);
      const denied = row.kind === "policy.denied";
      return {
        id: String(row.id),
        at: String(row.at),
        botId: String(row.bot_id),
        botName: text(row.bot_name, 200),
        groupId: typeof row.group_id === "string" ? row.group_id : null,
        groupName: text(row.group_name, 200),
        runId: typeof row.run_id === "string" ? row.run_id : null,
        tool,
        // Only reads reach the audit as calls; a refusal is a write when the catalog says so.
        kind: denied && tool && !readOnlyTools.has(tool) ? "write" : "read",
        outcome: denied
          ? "denied"
          : code === "connector_call_done"
            ? "done"
            : code === "connector_call_running"
              ? "running"
              : "failed",
        reasonCode:
          code === "connector_call_done" || code === "connector_call_running" ? null : code,
      };
    });
  }

  private drafts(id: string, cursor: Cursor, limit: number) {
    const rows = this.db
      .prepare(`SELECT d.approval_id AS id, a.created_at AS at, a.bot_id, a.run_id, d.status,
        json_extract(a.request, '$.draft.tool') AS tool,
        COALESCE(r.group_id, json_extract(d.payload, '$.groupId')) AS group_id,
        b.name AS bot_name, g.name AS group_name
      FROM send_drafts d
      JOIN approvals a ON a.id = d.approval_id
      LEFT JOIN runs r ON r.id = a.run_id
      LEFT JOIN bots b ON b.id = a.bot_id
      LEFT JOIN groups g ON g.id = COALESCE(r.group_id, json_extract(d.payload, '$.groupId'))
      WHERE d.connector_id = ?
        ${cursor ? "AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))" : ""}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
      .all(id, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []), limit);
    return rows.map((row): ConnectionUse => {
      const status = String(row.status);
      return {
        id: String(row.id),
        at: String(row.at),
        botId: String(row.bot_id),
        botName: text(row.bot_name, 200),
        groupId: typeof row.group_id === "string" ? row.group_id : null,
        groupName: text(row.group_name, 200),
        runId: typeof row.run_id === "string" ? row.run_id : null,
        tool: text(row.tool, 200),
        kind: "write",
        outcome:
          status === "sent"
            ? "done"
            : status === "pending"
              ? "pending"
              : status === "sending"
                ? "running"
                : status === "discarded"
                  ? "denied"
                  : "failed",
        reasonCode:
          status === "expired"
            ? "draft_expired"
            : status === "failed"
              ? "draft_failed"
              : status === "unknown"
                ? "draft_unknown"
                : null,
      };
    });
  }
}
