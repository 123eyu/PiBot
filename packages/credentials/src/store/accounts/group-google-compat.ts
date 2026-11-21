import type { DatabaseSync } from "node:sqlite";
import { GroupGoogleCompatSchema, IdSchema } from "@pibot/credentials-contract/full";

export class GroupGoogleCompatRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(groupId: string) {
    const row = this.db
      .prepare("SELECT id,google_compat_at,created_at FROM groups WHERE id=?")
      .get(IdSchema.parse(groupId));
    if (!row) return undefined;
    const enabledAt =
      row.google_compat_at === null ? null : String(row.google_compat_at || row.created_at);
    return GroupGoogleCompatSchema.parse({
      groupId: row.id,
      enabled: enabledAt !== null,
      enabledAt,
    });
  }
  enabled(groupId: string) {
    return this.get(groupId)?.enabled ?? false;
  }
  set(groupId: string, enabled: boolean) {
    this.db
      .prepare(
        `UPDATE groups SET google_compat_at=CASE WHEN ? THEN COALESCE(NULLIF(google_compat_at,''),?) ELSE NULL END WHERE id=?`,
      )
      .run(enabled ? 1 : 0, new Date().toISOString(), IdSchema.parse(groupId));
    return this.get(groupId);
  }
}
