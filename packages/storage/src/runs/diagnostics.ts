import type { DatabaseSync } from "node:sqlite";
import {
  DiagnosticRunSchema,
  DiagnosticsSnapshotSchema,
  DiagnosticToolSchema,
  diagnosticCode,
} from "@pibot/protocol-base";

const unknownPermission = () => ({
  state: "unknown" as const,
  nativeStatus: null,
  observedAt: null,
});
const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Export only explicit metadata columns; never load tool summaries, messages or result blobs. */
export class DiagnosticsRepo {
  constructor(private readonly db: DatabaseSync) {}

  tool(
    recordId: string,
    metadata: { errorCode: string | null; resultCount: number | null; connectorId: string | null },
  ) {
    this.db
      .prepare(`INSERT INTO tool_diagnostics(tool_record_id,error_code,result_count,connector_id)
      VALUES(?,?,?,?) ON CONFLICT(tool_record_id) DO UPDATE SET
      error_code=excluded.error_code,result_count=excluded.result_count,connector_id=excluded.connector_id`)
      .run(
        recordId,
        diagnosticCode(metadata.errorCode),
        numberOrNull(metadata.resultCount),
        metadata.connectorId,
      );
  }

  connector(connectorId: string, errorCode: string | null, nativeStatus: number | null) {
    const native =
      typeof nativeStatus === "number" &&
      Number.isInteger(nativeStatus) &&
      nativeStatus >= 0 &&
      nativeStatus <= 4
        ? nativeStatus
        : null;
    this.db
      .prepare(`INSERT INTO connector_diagnostics(connector_id,error_code,native_status,observed_at,native_observed_at,last_error_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(connector_id) DO UPDATE SET error_code=COALESCE(excluded.error_code,connector_diagnostics.error_code),
      native_status=COALESCE(excluded.native_status,connector_diagnostics.native_status),observed_at=excluded.observed_at,
      native_observed_at=COALESCE(excluded.native_observed_at,connector_diagnostics.native_observed_at),
      last_error_at=COALESCE(excluded.last_error_at,connector_diagnostics.last_error_at)`)
      .run(
        connectorId,
        diagnosticCode(errorCode),
        native,
        new Date().toISOString(),
        native === null ? null : new Date().toISOString(),
        diagnosticCode(errorCode) === null ? null : new Date().toISOString(),
      );
  }

  finishRun(runId: string) {
    // Count statuses in SQLite; TODO goals and item text never cross this boundary.
    const written = this.db
      .prepare(`INSERT OR IGNORE INTO run_diagnostics(run_id,unfinished_todo_count)
      SELECT r.id,(SELECT COUNT(*) FROM execution_todo t,json_each(t.plan_json,'$.items') i
        WHERE t.bot_id=r.bot_id AND t.conversation_id=r.conversation_id
        AND json_extract(i.value,'$.status') IN ('pending','in_progress'))
      FROM runs r WHERE r.id=? AND r.finished_at IS NOT NULL`)
      .run(runId).changes;
    if (!written) return undefined;
    const row = this.db.prepare(`${runColumns} WHERE r.id=?`).get(runId);
    return row ? parseRun(row) : undefined;
  }

  snapshot() {
    const connections = this.db
      .prepare(`SELECT c.id,c.kind AS type,c.status,
      c.status_detail_code AS statusCode,c.updated_at AS statusUpdatedAt,d.error_code AS lastCode,d.last_error_at AS errorAt
      FROM connectors c LEFT JOIN connector_diagnostics d ON d.connector_id=c.id
      WHERE c.removed_at IS NULL ORDER BY c.created_at DESC,c.id DESC LIMIT 501`)
      .all();
    const nativePermission = (app: string) => {
      // Only builtin installations can report native permission observations.
      const row = this.db
        .prepare(`SELECT d.native_status AS nativeStatus,d.native_observed_at AS observedAt
        FROM connector_diagnostics d JOIN connectors c ON c.id=d.connector_id
        JOIN plugin_installations p ON p.id=c.plugin_installation_id
        WHERE p.source_kind='builtin' AND p.plugin_id=? AND c.removed_at IS NULL
        AND d.native_status IS NOT NULL ORDER BY d.native_observed_at DESC LIMIT 1`)
        .get(app);
      return row
        ? { state: "observed" as const, nativeStatus: row.nativeStatus, observedAt: row.observedAt }
        : unknownPermission();
    };
    return DiagnosticsSnapshotSchema.parse({
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      connections: connections.slice(0, 500).map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        errorCode: diagnosticCode(row.statusCode) ?? diagnosticCode(row.lastCode),
        errorAt: diagnosticCode(row.statusCode) ? row.statusUpdatedAt : row.errorAt,
      })),
      connectionsTruncated: connections.length > 500,
      permissions: {
        accessibility: unknownPermission(),
        screenRecording: unknownPermission(),
        contacts: nativePermission("contacts"),
        calendar: nativePermission("calendar"),
      },
      runs: this.db
        .prepare(`${runColumns} ORDER BY r.created_at DESC,r.rowid DESC LIMIT 50`)
        .all()
        .map(parseRun),
      tools: this.db
        .prepare(`SELECT m.run_id AS runId,t.tool,t.status,d.error_code AS errorCode,
        t.duration_ms AS durationMs,d.result_count AS resultCount,d.connector_id AS connectorId,t.created_at AS createdAt
        FROM tool_calls t JOIN messages m ON m.id=t.message_id
        LEFT JOIN tool_diagnostics d ON d.tool_record_id=t.id
        ORDER BY t.created_at DESC,t.rowid DESC LIMIT 200`)
        .all()
        .map((row) =>
          DiagnosticToolSchema.parse({
            ...row,
            tool: diagnosticToolName(row.tool),
            errorCode: diagnosticCode(row.errorCode),
          }),
        ),
    });
  }
}

// The message join selects only the relationship key, never message content or usage.
const runColumns = `SELECT r.id AS runId,r.status,r.stop_reason AS stopReason,r.error_code AS errorCode,
  r.created_at AS createdAt,r.finished_at AS finishedAt,d.unfinished_todo_count AS unfinishedTodoCount,
  (SELECT COUNT(*) FROM tool_calls t JOIN messages m ON m.id=t.message_id WHERE m.run_id=r.id) AS toolCallCount
  FROM runs r LEFT JOIN run_diagnostics d ON d.run_id=r.id`;
function parseRun(row: Record<string, unknown>) {
  return DiagnosticRunSchema.parse({
    ...row,
    stopReason:
      typeof row.stopReason === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(row.stopReason)
        ? row.stopReason
        : null,
    errorCode: diagnosticCode(row.errorCode),
    zeroToolCalls: row.toolCallCount === 0,
  });
}
export function diagnosticToolName(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,255}$/.test(value)
    ? value
    : "unknown_tool";
}
