import type { DatabaseSync } from "node:sqlite";
import { connectorAuditEvents } from "@pibot/plugins-contract/full";
import { type AuditRepo, transaction } from "@pibot/storage";

const NOTION_PLUGIN_ID = "pibot.notion";

type Row = Record<string, unknown>;

/**
 * The Notion connection is installed by the brain, not imported by the person, so its
 * `plugin_access` row belongs to the knowledge source that points at it. Starting `selected` with
 * no targets and copying the source's assignments keeps the two in step: a Bot that is not
 * assigned the source cannot reach Notion through the ordinary connector tools either.
 *
 * The operation is idempotent so startup repair and a normal knowledge update can both run it.
 */
export function syncKnowledgeAccess(
  db: DatabaseSync,
  audit: AuditRepo,
  actorBotId: string,
  sourceId: string,
): string | undefined {
  const source = db
    .prepare("SELECT kind,config_json FROM knowledge_sources WHERE id=?")
    .get(sourceId) as Row | undefined;
  if (source?.kind !== "notion" || typeof source.config_json !== "string") return;
  let config: unknown;
  try {
    config = JSON.parse(source.config_json);
  } catch {
    return;
  }
  const connectorId = (config as { connectorId?: unknown } | null)?.connectorId;
  if (typeof connectorId !== "string") return;
  const connector = db
    .prepare("SELECT plugin_installation_id FROM connectors WHERE id=? AND removed_at IS NULL")
    .get(connectorId) as Row | undefined;
  if (!connector) return;
  const installationId = String(connector.plugin_installation_id);
  const installation = db
    .prepare("SELECT plugin_id,status FROM plugin_installations WHERE id=?")
    .get(installationId) as Row | undefined;
  if (
    !installation ||
    installation.plugin_id !== NOTION_PLUGIN_ID ||
    installation.status !== "installed"
  )
    return;

  const sourceRow = db
    .prepare("SELECT targets_all FROM knowledge_sources WHERE id=?")
    .get(sourceId) as Row | undefined;
  const all = Number(sourceRow?.targets_all) === 1;
  const targets = db
    .prepare(
      "SELECT target_kind,target_id FROM knowledge_assignments WHERE source_id=? ORDER BY target_kind,target_id",
    )
    .all(sourceId);
  const bots = targets
    .filter((target) => target.target_kind === "bot")
    .map((target) => String(target.target_id));
  const groups = targets
    .filter((target) => target.target_kind === "group")
    .map((target) => String(target.target_id));
  applyAccess(db, audit, actorBotId, installationId, all, bots, groups);
  return installationId;
}

/**
 * Startup repair for installations written before this task: they defaulted to `all`, which let
 * every Bot use the workspace directly. Sources that still exist are copied; installations no
 * source points at any more are restricted to nobody rather than left open.
 */
export function reconcileKnowledgeAccess(
  db: DatabaseSync,
  audit: AuditRepo,
  actorBotId: string,
): void {
  const sources = db.prepare("SELECT id FROM knowledge_sources WHERE kind='notion'").all();
  for (const source of sources) syncKnowledgeAccess(db, audit, actorBotId, String(source.id));

  // Only installations the brain created are ours to tighten. `source_kind='json'` also covers a
  // Notion MCP the person imported (0116 retired the built-in app that way); restricting that one
  // to nobody would take their working connection away from every Bot.
  const installations = db
    .prepare(
      `SELECT DISTINCT p.id FROM plugin_installations p
      JOIN connectors c ON c.plugin_installation_id=p.id AND c.removed_at IS NULL
      JOIN knowledge_managed_installations m ON m.installation_id=p.id
      WHERE p.plugin_id=? AND p.status='installed'`,
    )
    .all(NOTION_PLUGIN_ID);
  for (const installation of installations) {
    const id = String(installation.id);
    const pointed = db
      .prepare(
        `SELECT 1 FROM knowledge_sources k
        JOIN connectors c ON c.id=json_extract(k.config_json,'$.connectorId')
        WHERE k.kind='notion' AND c.plugin_installation_id=? AND c.removed_at IS NULL LIMIT 1`,
      )
      .get(id);
    if (!pointed) applyAccess(db, audit, actorBotId, id, false, [], []);
  }
}

/**
 * Only the connection the brain installed for a knowledge source may be tightened or
 * removed with that source. A Notion MCP the person imported themselves looks the same in every
 * other column, so this marker is the single source of truth.
 */
export function isKnowledgeManagedInstallation(db: DatabaseSync, installationId: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM knowledge_managed_installations WHERE installation_id=?")
      .get(installationId) !== undefined
  );
}

function applyAccess(
  db: DatabaseSync,
  audit: AuditRepo,
  actorBotId: string,
  installationId: string,
  all: boolean,
  bots: string[],
  groups: string[],
): boolean {
  const current = db
    .prepare("SELECT mode,bots_json,groups_json FROM plugin_access WHERE installation_id=?")
    .get(installationId) as Row | undefined;
  if (
    current?.mode === (all ? "all" : "selected") &&
    sameList(current.bots_json, all ? [] : bots) &&
    sameList(current.groups_json, all ? [] : groups)
  )
    return false;

  const now = new Date().toISOString();
  transaction(db, () => {
    if (current) {
      db.prepare(
        "UPDATE plugin_access SET mode=?,bots_json=?,groups_json=? WHERE installation_id=?",
      ).run(
        all ? "all" : "selected",
        JSON.stringify(all ? [] : bots),
        JSON.stringify(all ? [] : groups),
        installationId,
      );
    } else {
      db.prepare(
        "INSERT INTO plugin_access(installation_id,mode,bots_json,groups_json) VALUES(?,?,?,?)",
      ).run(
        installationId,
        all ? "all" : "selected",
        JSON.stringify(all ? [] : bots),
        JSON.stringify(all ? [] : groups),
      );
    }
    // The connection page and `connectors.get` compare revisions to detect a stale edit; access
    // changed underneath them, so both the installation and its connector move forward together.
    db.prepare("UPDATE plugin_installations SET revision=revision+1,updated_at=? WHERE id=?").run(
      now,
      installationId,
    );
    db.prepare(
      "UPDATE connectors SET revision=revision+1,updated_at=? WHERE plugin_installation_id=? AND removed_at IS NULL",
    ).run(now, installationId);
    audit.append({
      botId: actorBotId,
      kind: "connector.changed",
      summary: connectorAuditEvents.access,
      detail: { installationId, reasonCode: "knowledge_access_synced" },
    });
  });
  return true;
}

function sameList(value: unknown, expected: string[]): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value);
    return (
      Array.isArray(parsed) &&
      parsed.length === expected.length &&
      expected.every((item) => parsed.includes(item))
    );
  } catch {
    return false;
  }
}
