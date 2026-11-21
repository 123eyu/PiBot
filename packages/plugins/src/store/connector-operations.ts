import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ConnectorOperation,
  ConnectorOperationSchema,
  connectorAuditEvents,
  IdSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import type { AuditRepo } from "@pibot/storage";
import { transaction } from "@pibot/storage";
import {
  connectorConflict,
  connectorMissing,
  parseConnector,
  parseConnectorOperation,
} from "./connector-records.ts";

export const activeConnectorOperation = "state IN ('pending','running','stopping')";
export class ConnectorOperationsRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditRepo,
  ) {}

  get(id: string): ConnectorOperation | undefined {
    const row = this.db
      .prepare("SELECT * FROM connector_operations WHERE id=?")
      .get(IdSchema.parse(id));
    return row ? parseConnectorOperation(row) : undefined;
  }

  /** Intent and invalidation commit before any asynchronous cancellation or process work. */
  request(
    input: {
      id: string;
      expectedRevision: number;
      kind: Exclude<ConnectorOperation["kind"], "uninstall">;
    },
    actorBotId: string,
  ) {
    return transaction(this.db, () => {
      const row = this.db
        .prepare(`SELECT c.* FROM connectors c JOIN plugin_installations p
        ON p.id=c.plugin_installation_id WHERE c.id=? AND c.removed_at IS NULL AND p.status='installed'`)
        .get(IdSchema.parse(input.id));
      if (!row) connectorMissing();
      if (row.revision !== input.expectedRevision) connectorConflict();
      const id = String(row.id),
        installationId = String(row.plugin_installation_id);
      const now = new Date().toISOString();
      // Disable/disconnect supersede a pending start. Late callbacks fail their target revision.
      const active = this.db
        .prepare(
          `SELECT id FROM connector_operations WHERE connector_id=? AND ${activeConnectorOperation}`,
        )
        .get(id);
      if (active && (input.kind === "enable" || input.kind === "restart"))
        throw new RpcError(RpcErrorCodes.busy, "Connector operation in progress");
      this.db
        .prepare(`UPDATE connector_operations SET state='cancelled',phase='finished',
        failure_code='cancelled',revision=revision+1,updated_at=? WHERE connector_id=? AND ${activeConnectorOperation}`)
        .run(now, id);
      const start = input.kind === "enable" || input.kind === "restart";
      const revision = Number(row.revision) + 1;
      this.db
        .prepare(`UPDATE connectors SET revision=?,
        enabled=?,status=?,status_detail_code=NULL,updated_at=? WHERE id=?`)
        .run(
          revision,
          start ? 1 : 0,
          start && input.kind === "enable" && row.status === "disabled" ? "starting" : "stopping",
          now,
          id,
        );
      // Status and revision close dispatch while retaining the same catalog content receipt.
      this.db
        .prepare(`UPDATE plugin_installations SET enabled=EXISTS(SELECT 1 FROM connectors
        WHERE plugin_installation_id=? AND enabled=1 AND removed_at IS NULL),revision=revision+1,updated_at=? WHERE id=?`)
        .run(installationId, now, installationId);
      return this.insert(
        { installationId, connectorId: id, kind: input.kind, targetRevision: revision },
        actorBotId,
        now,
      );
    });
  }

  uninstall(installationId: string, expectedRevision: number, actorBotId: string) {
    return transaction(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT * FROM plugin_installations WHERE id=? AND status IN ('installed','removing')",
        )
        .get(IdSchema.parse(installationId));
      if (!row) connectorMissing();
      if (row.revision !== expectedRevision) connectorConflict();
      const now = new Date().toISOString();
      const activeUninstall = this.db
        .prepare(`SELECT * FROM connector_operations WHERE installation_id=? AND connector_id IS NULL
        AND kind='uninstall' AND ${activeConnectorOperation} ORDER BY rowid DESC LIMIT 1`)
        .get(installationId);
      if (row.status === "removing" && activeUninstall) {
        const operation = parseConnectorOperation(activeUninstall);
        if (operation.failureCode !== "cleanup_incomplete")
          throw new RpcError(RpcErrorCodes.busy, "Plugin cleanup already in progress");
        return this.resumeCleanup(operation.id, operation.revision, actorBotId);
      }
      this.db
        .prepare(`UPDATE connector_operations SET state='cancelled',phase='finished',failure_code='cancelled',
        revision=revision+1,updated_at=? WHERE installation_id=? AND ${activeConnectorOperation}`)
        .run(now, installationId);
      this.db
        .prepare(
          `UPDATE plugin_installations SET status='removing',enabled=0,revision=revision+1,updated_at=? WHERE id=?`,
        )
        .run(now, installationId);
      this.db
        .prepare(`UPDATE connectors SET enabled=0,status='stopping',revision=revision+1,
        catalog_version=catalog_version+1,updated_at=? WHERE plugin_installation_id=? AND removed_at IS NULL`)
        .run(now, installationId);
      this.db
        .prepare(`DELETE FROM connector_tools WHERE connector_id IN
        (SELECT id FROM connectors WHERE plugin_installation_id=?)`)
        .run(installationId);
      return this.insert(
        {
          installationId,
          connectorId: null,
          kind: "uninstall",
          targetRevision: expectedRevision + 1,
        },
        actorBotId,
        now,
      );
    });
  }

  /** Keep the uninstall intent active while exposing a safe, user-retryable cleanup failure. */
  cleanupIncomplete(id: string, expectedRevision: number, actorBotId: string) {
    return transaction(this.db, () => {
      const operation = this.current(id, expectedRevision);
      if (operation.kind !== "uninstall") throw new TypeError("Cleanup belongs to uninstall");
      const now = new Date().toISOString();
      this.db
        .prepare(`UPDATE connector_operations SET state='stopping',phase='draining',
        failure_code='cleanup_incomplete',revision=revision+1,updated_at=? WHERE id=?`)
        .run(now, id);
      this.db
        .prepare(`UPDATE connectors SET status='error',status_detail_code='cleanup_incomplete',
        updated_at=? WHERE plugin_installation_id=? AND removed_at IS NULL`)
        .run(now, operation.installationId);
      this.audit.append({
        botId: IdSchema.parse(actorBotId),
        kind: "connector.changed",
        summary: connectorAuditEvents.failed,
        detail: {
          installationId: operation.installationId,
          connectorOperationId: id,
          reasonCode: "cleanup_incomplete",
        },
      });
      return this.get(id) as ConnectorOperation;
    });
  }

  /** Manual retry and startup recovery both resume the same durable uninstall intent. */
  resumeCleanup(id: string, expectedRevision: number, actorBotId: string) {
    return transaction(this.db, () => {
      const operation = this.current(id, expectedRevision);
      if (operation.kind !== "uninstall" || operation.failureCode !== "cleanup_incomplete")
        throw new RpcError(RpcErrorCodes.busy, "Plugin cleanup is not waiting for retry");
      const now = new Date().toISOString();
      this.db
        .prepare(`UPDATE connector_operations SET state='stopping',phase='draining',failure_code=NULL,
        revision=revision+1,updated_at=? WHERE id=?`)
        .run(now, id);
      this.db
        .prepare(`UPDATE connectors SET status='stopping',status_detail_code=NULL,updated_at=?
        WHERE plugin_installation_id=? AND removed_at IS NULL`)
        .run(now, operation.installationId);
      this.audit.append({
        botId: IdSchema.parse(actorBotId),
        kind: "connector.changed",
        summary: connectorAuditEvents.intent,
        detail: {
          internal: true,
          installationId: operation.installationId,
          connectorOperationId: id,
          revision: operation.revision + 1,
        },
      });
      return this.get(id) as ConnectorOperation;
    });
  }

  /** Recovery is paginated; no process is started from a repository or inside a transaction. */
  pending(after?: string, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Invalid page size");
    const rows = this.db
      .prepare(`SELECT * FROM connector_operations WHERE ${activeConnectorOperation}
      AND id>? ORDER BY id LIMIT ?`)
      .all(after ? IdSchema.parse(after) : "", limit + 1);
    const items = rows.slice(0, limit).map(parseConnectorOperation);
    return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }

  /** Repair old failed-uninstall display state; no runtime work or credential cleanup is implied. */
  reconcileFailedUninstalls(actorBotId: string, after?: string, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Invalid page size");
    return transaction(this.db, () => {
      // rowid orders persisted intents even if the wall clock moved backwards between attempts.
      const rows = this.db
        .prepare(`SELECT c.*,o.failure_code AS uninstall_failure FROM connectors c
        JOIN plugin_installations p ON p.id=c.plugin_installation_id
        JOIN connector_operations o ON o.id=(SELECT last.id FROM connector_operations last
          WHERE last.installation_id=p.id AND last.kind='uninstall' ORDER BY last.rowid DESC LIMIT 1)
        WHERE p.status='removing' AND c.status='stopping' AND c.removed_at IS NULL
          AND o.state IN ('error','cancelled') AND o.phase='finished'
          AND NOT EXISTS(SELECT 1 FROM connector_operations active
            WHERE active.installation_id=p.id AND active.${activeConnectorOperation})
          AND c.id>? ORDER BY c.id LIMIT ?`)
        .all(after ? IdSchema.parse(after) : "", limit + 1);
      const items = rows.slice(0, limit).map((row) => {
        const failure = String(row.uninstall_failure ?? "connection_failed");
        const now = new Date().toISOString();
        this.db
          .prepare(
            "UPDATE connectors SET status='error',status_detail_code=?,updated_at=? WHERE id=?",
          )
          .run(failure, now, String(row.id));
        this.audit.append({
          botId: IdSchema.parse(actorBotId),
          kind: "connector.changed",
          summary: connectorAuditEvents.recovered,
          detail: { connectorId: String(row.id), reasonCode: String(failure) },
        });
        return parseConnector({
          ...row,
          status: "error",
          status_detail_code: failure,
          updated_at: now,
        });
      });
      return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
    });
  }

  /** Runtime may advance progress, but must still match the persisted target generation. */
  progress(
    id: string,
    expectedRevision: number,
    phase: Exclude<ConnectorOperation["phase"], "finished">,
  ) {
    return transaction(this.db, () => {
      const operation = this.current(id, expectedRevision);
      const now = new Date().toISOString();
      const parsed = ConnectorOperationSchema.parse({
        ...operation,
        revision: operation.revision + 1,
        state: phase === "draining" ? "stopping" : "running",
        phase,
        updatedAt: now,
      });
      this.db
        .prepare(
          "UPDATE connector_operations SET state=?,phase=?,revision=?,updated_at=? WHERE id=?",
        )
        .run(parsed.state, phase, parsed.revision, now, id);
      return parsed;
    });
  }

  /** Used only after runtime has truly drained owned resources. Never called on mere cancellation. */
  finishStopped(id: string, expectedRevision: number, actorBotId: string) {
    return transaction(this.db, () => {
      const operation = this.current(id, expectedRevision);
      if (operation.kind === "enable" || operation.kind === "restart")
        throw new TypeError("Start operations require a published catalog");
      const now = new Date().toISOString();
      if (operation.kind === "uninstall") {
        this.db
          .prepare(
            "UPDATE plugin_installations SET status='removed',revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(now, operation.installationId);
        this.db
          .prepare(`UPDATE connectors SET status='disabled',removed_at=?,updated_at=?
          WHERE plugin_installation_id=? AND removed_at IS NULL`)
          .run(now, now, operation.installationId);
      } else {
        this.db
          .prepare("UPDATE connectors SET status='disabled',removed_at=?,updated_at=? WHERE id=?")
          .run(operation.kind === "disconnect" ? now : null, now, operation.connectorId);
      }
      this.db
        .prepare(
          `UPDATE connector_operations SET state='done',phase='finished',revision=revision+1,updated_at=? WHERE id=?`,
        )
        .run(now, id);
      this.audit.append({
        botId: IdSchema.parse(actorBotId),
        kind: "connector.changed",
        summary: connectorAuditEvents.drained,
        detail: {
          internal: true,
          installationId: operation.installationId,
          connectorOperationId: id,
        },
      });
      return this.get(id) as ConnectorOperation;
    });
  }

  /** Caller has closed any partial transport before recording failure; setup/auth remain retryable. */
  fail(
    id: string,
    expectedRevision: number,
    failureCode: ConnectorOperation["failureCode"],
    actorBotId: string,
  ) {
    return transaction(this.db, () => {
      const operation = this.current(id, expectedRevision);
      if (!failureCode) throw new TypeError("Failure code required");
      ConnectorOperationSchema.shape.failureCode.parse(failureCode);
      const now = new Date().toISOString();
      this.db
        .prepare(`UPDATE connector_operations SET state='error',phase='finished',failure_code=?,
        revision=revision+1,updated_at=? WHERE id=?`)
        .run(failureCode, now, id);
      if (operation.connectorId) {
        const status =
          failureCode === "secret_required"
            ? "needs_setup"
            : failureCode === "auth_required"
              ? "needs_auth"
              : "error";
        this.db
          .prepare("UPDATE connectors SET status=?,status_detail_code=?,updated_at=? WHERE id=?")
          .run(status, failureCode, now, operation.connectorId);
      } else if (operation.kind === "uninstall") {
        // The installation still owns any undrained resources. Expose a retryable failure,
        // rather than leaving its connections looking like an operation is still running.
        this.db
          .prepare(`UPDATE connectors SET status='error',status_detail_code=?,updated_at=?
          WHERE plugin_installation_id=? AND removed_at IS NULL`)
          .run(failureCode, now, operation.installationId);
      }
      this.audit.append({
        botId: IdSchema.parse(actorBotId),
        kind: "connector.changed",
        summary: connectorAuditEvents.failed,
        detail: {
          installationId: operation.installationId,
          connectorOperationId: id,
          reasonCode: failureCode,
        },
      });
      return this.get(id) as ConnectorOperation;
    });
  }

  current(id: string, expectedRevision: number): ConnectorOperation {
    const row = this.db
      .prepare(`SELECT * FROM connector_operations WHERE id=? AND ${activeConnectorOperation}`)
      .get(IdSchema.parse(id));
    if (!row || row.revision !== expectedRevision) connectorConflict();
    const resource = row.connector_id
      ? this.db
          .prepare("SELECT revision FROM connectors WHERE id=? AND removed_at IS NULL")
          .get(String(row.connector_id))
      : this.db
          .prepare("SELECT revision FROM plugin_installations WHERE id=? AND status='removing'")
          .get(String(row.installation_id));
    if (!resource || resource.revision !== row.target_revision) connectorConflict();
    return parseConnectorOperation(row);
  }

  private insert(
    input: {
      installationId: string;
      connectorId: string | null;
      kind: ConnectorOperation["kind"];
      targetRevision: number;
    },
    actorBotId: string,
    now: string,
  ) {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO connector_operations(id,installation_id,connector_id,kind,target_revision,revision,state,phase,failure_code,created_at,updated_at)
      VALUES(?,?,?,?,?,1,'pending','queued',NULL,?,?)`)
      .run(id, input.installationId, input.connectorId, input.kind, input.targetRevision, now, now);
    this.audit.append({
      botId: IdSchema.parse(actorBotId),
      kind: "connector.changed",
      summary: connectorAuditEvents.intent,
      detail: {
        internal: true,
        installationId: input.installationId,
        connectorOperationId: id,
        revision: input.targetRevision,
      },
    });
    return this.get(id) as ConnectorOperation;
  }
}
