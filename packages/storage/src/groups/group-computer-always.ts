import type { DatabaseSync } from "node:sqlite";
import {
  type ComputerApp,
  ComputerAppListSchema,
  ComputerAppSchema,
  GroupComputerAlwaysSchema,
  IdSchema,
} from "@pibot/protocol-base";
import { AppBlocklistRepo } from "../computer/app-blocklist.ts";
import { transaction } from "../database/database.ts";
import { GrantsRepo } from "../permissions/grants.ts";

/** The group's remembered app grants are the runtime's existing source of truth. */
export class GroupComputerAlwaysRepo {
  constructor(private readonly db: DatabaseSync) {}
  private group(groupId: string) {
    const group = this.db
      .prepare("SELECT coordinator_bot_id FROM groups WHERE id=?")
      .get(IdSchema.parse(groupId));
    if (!group) throw new TypeError("Unknown group");
    return group;
  }
  get(groupId: string) {
    this.group(groupId);
    const rows = this.db
      .prepare(`SELECT MIN(app.value) AS id,MAX(g.created_at) AS updatedAt
      FROM grants g,json_each(g.scope,'$.apps') app
      WHERE g.group_id=? AND g.category='computer' AND g.revoked_at IS NULL
        AND json_extract(g.scope,'$.kind')='apps'
      GROUP BY lower(app.value) ORDER BY lower(app.value) LIMIT 51`)
      .all(groupId);
    if (!rows.length) return null;
    // More than the editable limit is not silently truncated and overwritten.
    if (rows.length > 50) throw new TypeError("Computer app list exceeds editable limit");
    const saved = this.db
      .prepare("SELECT names FROM group_computer_app_names WHERE group_id=?")
      .get(groupId);
    const names = saved
      ? ComputerAppSchema.array()
          .max(50)
          .parse(JSON.parse(String(saved.names)))
      : [];
    const byId = new Map(names.map((app) => [app.id.toLowerCase(), app.name]));
    return GroupComputerAlwaysSchema.parse({
      groupId,
      apps: rows.map((row) => ({
        id: String(row.id),
        name: byId.get(String(row.id).toLowerCase()) ?? String(row.id).slice(0, 200),
      })),
      updatedAt: rows.reduce(
        (latest, row) => (String(row.updatedAt) > latest ? String(row.updatedAt) : latest),
        "",
      ),
    });
  }
  set(groupId: string, input: ComputerApp[]) {
    const apps = ComputerAppListSchema.parse(input);
    return transaction(this.db, () => {
      const group = this.group(groupId);
      if (new AppBlocklistRepo(this.db).blockedAmong(apps.map((app) => app.id)).size)
        throw new TypeError("Blocked app");
      this.clear(groupId);
      this.db
        .prepare(
          "INSERT INTO group_computer_app_names(group_id,names) VALUES (?,?) ON CONFLICT(group_id) DO UPDATE SET names=excluded.names",
        )
        .run(groupId, JSON.stringify(apps));
      new GrantsRepo(this.db).create({
        botId: String(group.coordinator_bot_id),
        groupId,
        category: "computer",
        scope: { kind: "apps", apps: apps.map((app) => app.id) },
      });
      return GroupComputerAlwaysSchema.parse({
        groupId,
        apps,
        updatedAt: new Date().toISOString(),
      });
    });
  }
  clear(groupId: string) {
    return transaction(this.db, () => {
      this.group(groupId);
      this.db.prepare("DELETE FROM group_computer_app_names WHERE group_id=?").run(groupId);
      return (
        this.db
          .prepare(`UPDATE grants SET revoked_at=? WHERE group_id=? AND category='computer'
        AND revoked_at IS NULL AND json_extract(scope,'$.kind')='apps'`)
          .run(new Date().toISOString(), groupId).changes > 0
      );
    });
  }
}
