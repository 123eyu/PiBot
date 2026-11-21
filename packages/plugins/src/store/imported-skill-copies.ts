import type { DatabaseSync } from "node:sqlite";
import { ConnectorAccessSchema } from "@pibot/plugins-contract/full";

export interface SkillCopyTarget {
  target_kind: "bot" | "group";
  target_id: string;
  bot_id: string;
}
export type SkillCopyKey = [string, string, string, string, string];

/** No cascading foreign keys: deleting the source or an edited copy must never recreate it. */
export class ImportedSkillCopiesRepo {
  constructor(private readonly db: DatabaseSync) {}
  enqueue(id: string, target: SkillCopyTarget) {
    this.db
      .prepare(`INSERT INTO plugin_skill_copy_jobs
      (installation_id,target_kind,target_id,bot_id) VALUES(?,?,?,?)
      ON CONFLICT(installation_id,target_kind,target_id,bot_id) DO UPDATE SET
        state='pending',abandoned_reason=NULL,abandon_audited=0`)
      .run(id, target.target_kind, target.target_id, target.bot_id);
  }
  /** Recovery is installation-scoped and includes skill-only imports, before pagination. */
  pendingPage({ before, limit = 50 }: { before?: string; limit?: number }) {
    const scope = `WITH imports AS (
      SELECT p.id AS installationId,p.revision,p.manifest_json,
        CASE WHEN json_valid(s.value) THEN
          CASE WHEN json_type(s.value,'$.skillCount')='integer' THEN
            min(100,max(0,json_extract(s.value,'$.skillCount'))) ELSE 0 END
          ELSE 0 END AS skillCount,
        (SELECT count(DISTINCT c.skill_path) FROM plugin_skill_copies c WHERE c.installation_id=p.id) AS copiedCount,
        (SELECT count(*) FROM plugin_skill_copy_jobs j WHERE j.installation_id=p.id AND j.state<>'done') AS pendingTargetCount,
        (SELECT count(DISTINCT c.skill_path) FROM plugin_skill_copies c WHERE c.installation_id=p.id
          AND c.available_hash IS NOT NULL) AS updateCount
      FROM plugin_installations p LEFT JOIN settings s ON s.key='plugin-import:'||p.id
      WHERE p.status='installed' AND p.source_kind='directory'
    ), pending AS (
      SELECT installationId,revision,manifest_json,max(0,skillCount-copiedCount) AS unassignedCount,pendingTargetCount,updateCount
      FROM imports WHERE skillCount>copiedCount OR pendingTargetCount>0
    )`;
    const totalCount = Number(
      this.db.prepare(`${scope} SELECT count(*) AS n FROM pending`).get()?.n ?? 0,
    );
    const rows = this.db
      .prepare(`${scope} SELECT * FROM pending
      WHERE (? IS NULL OR installationId<?) ORDER BY installationId DESC LIMIT ?`)
      .all(before ?? null, before ?? null, limit + 1);
    const items = rows.slice(0, limit);
    return {
      items,
      totalCount,
      nextBefore: rows.length > limit ? String(items.at(-1)?.installationId) : null,
    };
  }
  copiedCount(id: string) {
    return Number(
      this.db
        .prepare(
          "SELECT count(DISTINCT skill_path) AS n FROM plugin_skill_copies WHERE installation_id=?",
        )
        .get(id)?.n ?? 0,
    );
  }
  /** Number of this installation's skills whose target already held an older copy. */
  updateCount(id: string) {
    return Number(
      this.db
        .prepare(`SELECT count(DISTINCT skill_path) AS n FROM plugin_skill_copies
        WHERE installation_id=? AND available_hash IS NOT NULL`)
        .get(id)?.n ?? 0,
    );
  }
  targets(id: string, after: string) {
    return this.db
      .prepare(`SELECT *,target_kind||':'||target_id||':'||bot_id AS cursor
      FROM plugin_skill_copy_jobs WHERE installation_id=? AND state<>'done'
      AND target_kind||':'||target_id||':'||bot_id>? ORDER BY cursor LIMIT 50`)
      .all(id, after) as unknown as (SkillCopyTarget & { cursor: string })[];
  }
  has(key: SkillCopyKey) {
    return !!this.db
      .prepare(
        `SELECT 1 FROM plugin_skill_copies WHERE installation_id=? AND skill_path=? AND target_kind=? AND target_id=? AND bot_id=?`,
      )
      .get(...key);
  }
  record(key: SkillCopyKey, digest: string, skillId: string, availableHash: string | null = null) {
    this.db
      .prepare(`INSERT INTO plugin_skill_copies
      (installation_id,skill_path,target_kind,target_id,bot_id,content_hash,skill_id,created_at,available_hash)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(...key, digest, skillId, new Date().toISOString(), availableHash);
  }
  /**
   * The newest copy of the same plugin's skill already given to this target by an earlier import
   * (any installation, removed ones included: copies outlive their source). A user-deleted copy
   * still counts, so re-importing never silently brings back a skill the user removed.
   */
  earlierCopy(pluginId: string, key: SkillCopyKey) {
    const [installationId, skillPath, targetKind, targetId, botId] = key;
    const row = this.db
      .prepare(`SELECT c.content_hash,c.skill_id FROM plugin_skill_copies c
      JOIN plugin_installations p ON p.id=c.installation_id
      WHERE c.skill_path=? AND c.target_kind=? AND c.target_id=? AND c.bot_id=?
      AND c.installation_id<>? AND p.plugin_id=?
      ORDER BY c.created_at DESC LIMIT 1`)
      .get(skillPath, targetKind, targetId, botId, installationId, pluginId);
    return row
      ? { contentHash: String(row.content_hash), skillId: String(row.skill_id) }
      : undefined;
  }
  /** Settles a job whose target can never become valid; it stays out of every retry. */
  abandon(id: string, target: SkillCopyTarget) {
    this.db
      .prepare(`UPDATE plugin_skill_copy_jobs
      SET state='done',abandoned_reason='target_unavailable',abandon_audited=1
      WHERE installation_id=? AND target_kind=? AND target_id=? AND bot_id=?`)
      .run(id, target.target_kind, target.target_id, target.bot_id);
  }
  /** Rows the 0095 cleanup settled in SQL; brain audits each one once. */
  unauditedAbandoned() {
    return this.db
      .prepare(`SELECT installation_id,target_kind,target_id,bot_id FROM plugin_skill_copy_jobs
      WHERE abandoned_reason IS NOT NULL AND abandon_audited=0
      ORDER BY installation_id,target_kind,target_id,bot_id LIMIT 100`)
      .all() as unknown as (SkillCopyTarget & { installation_id: string })[];
  }
  markAbandonAudited(id: string, target: SkillCopyTarget) {
    this.db
      .prepare(`UPDATE plugin_skill_copy_jobs SET abandon_audited=1
      WHERE installation_id=? AND target_kind=? AND target_id=? AND bot_id=?`)
      .run(id, target.target_kind, target.target_id, target.bot_id);
  }
  finishTarget(id: string, target: SkillCopyTarget, failed: boolean) {
    this.db
      .prepare(
        `UPDATE plugin_skill_copy_jobs SET state=? WHERE installation_id=? AND target_kind=? AND target_id=? AND bot_id=?`,
      )
      .run(failed ? "failed" : "done", id, target.target_kind, target.target_id, target.bot_id);
  }
  validateFrozen(id: string): boolean {
    const row = this.db
      .prepare(
        "SELECT * FROM plugin_skill_copy_migrations WHERE installation_id=? AND state<>'done'",
      )
      .get(id);
    if (!row) return true;
    try {
      ConnectorAccessSchema.parse({
        mode: row.mode,
        bots: JSON.parse(String(row.bots_json)),
        groups: JSON.parse(String(row.groups_json)),
      });
      return true;
    } catch {
      // Discard latent broad jobs before any later explicit assignment can run them.
      this.db.prepare("DELETE FROM plugin_skill_copy_jobs WHERE installation_id=?").run(id);
      this.migrationState(id, "failed");
      return false;
    }
  }
  migrationState(id: string, state: "done" | "failed") {
    this.db
      .prepare("UPDATE plugin_skill_copy_migrations SET state=? WHERE installation_id=?")
      .run(state, id);
  }
  migrationPage(after: string) {
    return this.db
      .prepare(`SELECT p.id FROM plugin_installations p
      LEFT JOIN plugin_skill_copy_migrations m ON m.installation_id=p.id
      WHERE p.status='installed' AND p.source_kind='directory' AND p.id>?
      AND (m.state IN ('pending','failed') OR EXISTS(SELECT 1 FROM plugin_skill_copy_jobs j WHERE j.installation_id=p.id AND j.state<>'done'))
      ORDER BY p.id LIMIT 25`)
      .all(after)
      .map((row) => String(row.id));
  }
  pendingCount(id: string) {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM plugin_skill_copy_jobs WHERE installation_id=? AND state<>'done'",
        )
        .get(id)?.n ?? 0,
    );
  }
}
