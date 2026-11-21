import type { DatabaseSync } from "node:sqlite";
import {
  accessAllows,
  type ConnectorAccess,
  ConnectorAccessSchema,
  connectorAuditEvents,
  IdSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import type { AuditRepo } from "@pibot/storage";
import { transaction } from "@pibot/storage";

const missing = () => {
  throw new RpcError(RpcErrorCodes.connectorUnavailable, "Plugin unavailable");
};
const conflict = () => {
  throw new RpcError(RpcErrorCodes.connectorStale, "Plugin changed");
};

/** Connection scope shared by the tools in one installed plugin. */
export class PluginAccessRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditRepo,
  ) {}

  get(installationId: string): ConnectorAccess {
    const row = this.db
      .prepare(`SELECT a.mode,a.bots_json,a.groups_json FROM plugin_access a
      JOIN plugin_installations p ON p.id=a.installation_id
      WHERE a.installation_id=? AND p.status='installed'`)
      .get(IdSchema.parse(installationId));
    if (!row) return missing();
    return ConnectorAccessSchema.parse({
      mode: row.mode,
      bots: JSON.parse(String(row.bots_json)),
      groups: JSON.parse(String(row.groups_json)),
    });
  }

  forConnector(connectorId: string): ConnectorAccess {
    const row = this.db
      .prepare("SELECT plugin_installation_id FROM connectors WHERE id=? AND removed_at IS NULL")
      .get(IdSchema.parse(connectorId));
    if (!row) return missing();
    return this.get(String(row.plugin_installation_id));
  }

  /**
   * Maintainers 2026-10-24: a group run uses only the group's grant and a direct chat only the Bot's,
   * so a plugin given to a Bot privately never follows it into a group (and vice versa).
   */
  visible(access: ConnectorAccess, botId: string, groupId?: string): boolean {
    return accessAllows(access, botId, groupId);
  }

  update(
    installationId: string,
    expectedRevision: number,
    accessInput: ConnectorAccess,
    actorBotId: string,
  ) {
    const legacy = ConnectorAccessSchema.parse(accessInput);
    const access =
      legacy.mode === "ask_first" ? { mode: "all" as const, bots: [], groups: [] } : legacy;
    return transaction(this.db, () => {
      const current = this.db
        .prepare("SELECT revision FROM plugin_installations WHERE id=? AND status='installed'")
        .get(IdSchema.parse(installationId));
      if (!current) return missing();
      if (Number(current.revision) !== expectedRevision) return conflict();
      const now = new Date().toISOString();
      if (legacy.mode === "ask_first") {
        this.db
          .prepare(
            "UPDATE connectors SET confirmation_mode='always_ask' WHERE plugin_installation_id=? AND removed_at IS NULL",
          )
          .run(installationId);
      }
      this.db
        .prepare(
          "UPDATE plugin_access SET mode=?,bots_json=?,groups_json=? WHERE installation_id=?",
        )
        .run(
          access.mode,
          JSON.stringify(access.bots),
          JSON.stringify(access.groups),
          installationId,
        );
      const nextRevision = expectedRevision + 1;
      this.db
        .prepare("UPDATE plugin_installations SET revision=?,updated_at=? WHERE id=?")
        .run(nextRevision, now, installationId);
      // Every pending connector receipt for the plugin becomes stale with the shared access row.
      this.db
        .prepare(
          "UPDATE connectors SET revision=revision+1,updated_at=? WHERE plugin_installation_id=? AND removed_at IS NULL",
        )
        .run(now, installationId);
      this.audit.append({
        botId: IdSchema.parse(actorBotId),
        kind: "connector.changed",
        summary: connectorAuditEvents.access,
        detail: {
          installationId,
          revision: nextRevision,
        },
      });
      return nextRevision;
    });
  }
}
