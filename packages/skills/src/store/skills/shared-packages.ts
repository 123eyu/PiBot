import type { DatabaseSync } from "node:sqlite";
import { packageIdOf } from "./skills.ts";

export class SharedSkillPackagesRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): { digest: string; unreferencedAt: string | null } | undefined {
    const row = this.db
      .prepare("SELECT digest,unreferenced_at FROM skill_packages WHERE id=?")
      .get(packageIdOf(id));
    return row
      ? {
          digest: String(row.digest),
          unreferencedAt: row.unreferenced_at == null ? null : String(row.unreferenced_at),
        }
      : undefined;
  }
  register(id: string, digest: string, at: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO skill_packages(id,digest,created_at,unreferenced_at) VALUES(?,?,?,NULL)",
      )
      .run(packageIdOf(id), digest, at);
  }
  referenced(id: string): boolean {
    return !!this.db
      .prepare(
        // A downloaded update is nothing but a published tree until the user applies it, so it has
        // no reference row yet; without this it would be collected at the next startup.
        "SELECT 1 FROM skills WHERE package_id=? UNION ALL SELECT 1 FROM group_member_skills WHERE package_id=? UNION ALL SELECT 1 FROM skill_updates WHERE pending_package_id=? LIMIT 1",
      )
      .get(packageIdOf(id), id, packageIdOf(id));
  }
  page(after: string): string[] {
    return this.db
      .prepare("SELECT id FROM skill_packages WHERE id>? ORDER BY id LIMIT 256")
      .all(after)
      .map((row) => packageIdOf(row.id));
  }
  remove(id: string): void {
    this.db.prepare("DELETE FROM skill_packages WHERE id=?").run(packageIdOf(id));
  }
}
