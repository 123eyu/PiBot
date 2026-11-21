import type { DatabaseSync } from "node:sqlite";

/** Bounded startup backfill of role Bots and their current group memberships. */
export class BuiltinMethodTargetsRepo {
  constructor(private readonly db: DatabaseSync) {}
  role(botId: string, groupId?: string): string | undefined {
    const role = this.displayRole(botId, groupId);
    return role === "researcher" || role === "data-analyst" ? role : undefined;
  }
  /** Display labels apply to every shipped role; trusted provisioning keeps its narrower set. */
  displayRole(botId: string, groupId?: string): string | undefined {
    const row = this.db
      .prepare(`SELECT role_id FROM bots WHERE id=? AND archived_at IS NULL
      AND category<>'image' AND role_id IS NOT NULL
      AND (? IS NULL OR EXISTS (SELECT 1 FROM group_members
        WHERE bot_id=bots.id AND group_id=? AND left_at IS NULL))`)
      .get(botId, groupId ?? null, groupId ?? null);
    return row ? String(row.role_id) : undefined;
  }
  page(after = "", limit = 50) {
    return this.db
      .prepare(`SELECT b.id,b.role_id AS roleId FROM bots b
      WHERE b.id>? AND b.archived_at IS NULL AND b.category<>'image'
      AND b.role_id IN ('researcher','data-analyst') ORDER BY b.id LIMIT ?`)
      .all(after, limit)
      .map((row) => ({ botId: String(row.id), roleId: String(row.roleId) }));
  }
  groups(botId: string, after = "", limit = 50): string[] {
    return this.db
      .prepare(`SELECT group_id FROM group_members WHERE bot_id=? AND left_at IS NULL AND group_id>?
      ORDER BY group_id LIMIT ?`)
      .all(botId, after, limit)
      .map((row) => String(row.group_id));
  }
}
