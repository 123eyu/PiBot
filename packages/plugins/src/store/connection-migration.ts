import type { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { ConnectorAccessSchema, connectorAuditEvents } from "@pibot/plugins-contract/full";
import { type AuditRepo, transaction } from "@pibot/storage";

/** Each installation settles independently; a broken legacy grant cannot open its tools. */
export async function migrateConnectionAccess(
  db: DatabaseSync,
  audit: AuditRepo,
  actorBotId: string,
  signal: AbortSignal,
) {
  let after = "";
  while (true) {
    signal.throwIfAborted();
    const rows = db
      .prepare(`SELECT * FROM connection_access_migrations
      WHERE state='pending' AND installation_id>? ORDER BY installation_id LIMIT 100`)
      .all(after);
    if (!rows.length) break;
    for (const row of rows) {
      const id = String(row.installation_id);
      after = id;
      try {
        const access = ConnectorAccessSchema.parse({
          mode: row.mode,
          bots: JSON.parse(String(row.bots_json)),
          groups: JSON.parse(String(row.groups_json)),
        });
        transaction(db, () => {
          if (access.mode === "ask_first") {
            db.prepare(
              "UPDATE plugin_access SET mode='all',bots_json='[]',groups_json='[]' WHERE installation_id=?",
            ).run(id);
            db.prepare(
              "UPDATE connectors SET confirmation_mode='always_ask',revision=revision+1 WHERE plugin_installation_id=?",
            ).run(id);
            db.prepare("UPDATE plugin_installations SET revision=revision+1 WHERE id=?").run(id);
            // Queue the first-use restore check with the revision this write produced,
            // so the check can tell this mode from one the user chose later.
            db.prepare(`INSERT OR IGNORE INTO connection_confirmation_restores
              (connector_id,installation_id,migrated_revision)
              SELECT id,plugin_installation_id,revision FROM connectors
              WHERE plugin_installation_id=? AND removed_at IS NULL`).run(id);
          }
          audit.append({
            botId: actorBotId,
            kind: "connector.changed",
            summary: connectorAuditEvents.access,
            detail: { installationId: id, reasonCode: "connection_permissions_migrated" },
          });
          db.prepare(
            "UPDATE connection_access_migrations SET state='migrated' WHERE installation_id=?",
          ).run(id);
        });
      } catch {
        // The snapshot remains intact for diagnosis and the later skill-copy migration.
        transaction(db, () => {
          db.prepare(
            "UPDATE plugin_installations SET enabled=0,revision=revision+1 WHERE id=?",
          ).run(id);
          db.prepare(
            "UPDATE connectors SET enabled=0,status='needs_setup',status_detail_code='invalid_source',revision=revision+1 WHERE plugin_installation_id=?",
          ).run(id);
          db.prepare(
            "UPDATE plugin_access SET mode='selected',bots_json='[]',groups_json='[]' WHERE installation_id=?",
          ).run(id);
          db.prepare(
            "UPDATE plugin_skill_access SET mode='selected',bots_json='[]',groups_json='[]' WHERE installation_id=?",
          ).run(id);
          audit.append({
            botId: actorBotId,
            kind: "connector.changed",
            summary: connectorAuditEvents.failed,
            detail: { installationId: id, reasonCode: "connection_permissions_migration_failed" },
          });
          db.prepare(
            "UPDATE connection_access_migrations SET state='failed' WHERE installation_id=?",
          ).run(id);
        });
      }
    }
    await setImmediate(undefined, { signal });
  }
}
