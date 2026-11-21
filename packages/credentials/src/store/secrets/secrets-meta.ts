import type { DatabaseSync } from "node:sqlite";
import {
  type SecretAssignment,
  type UserSecretMeta,
  UserSecretMetaSchema,
} from "@pibot/credentials-contract/full";

const columns = `m.name, m.description, m.assignment_json, m.revision,
 m.created_at AS createdAt, m.updated_at AS updatedAt, s.last_used_at AS lastUsedAt,
 s.name IS NOT NULL AS hasValue`;
const source = `secrets_meta m LEFT JOIN secrets s ON s.scope='user-secret' AND s.name=m.name`;
function parse(row: Record<string, unknown>): UserSecretMeta {
  const { assignment_json, hasValue, ...rest } = row;
  return UserSecretMetaSchema.parse({
    ...rest,
    assignment: JSON.parse(String(assignment_json)),
    hasValue: !!hasValue,
  });
}
export class SecretMetaRepo {
  constructor(private readonly db: DatabaseSync) {}
  list({ cursor = "", limit = 50 }: { cursor?: string; limit?: number } = {}) {
    const rows = this.db
      .prepare(`SELECT ${columns} FROM ${source} WHERE m.name > ? ORDER BY m.name ASC LIMIT ?`)
      .all(cursor, limit + 1);
    const items = rows.slice(0, limit).map(parse);
    return { items, ...(rows.length > limit ? { nextCursor: items.at(-1)?.name } : {}) };
  }
  get(name: string): UserSecretMeta | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM ${source} WHERE m.name=?`).get(name);
    return row ? parse(row) : undefined;
  }
  nextRevision(): number {
    const row = this.db
      .prepare(
        "UPDATE secret_revision_sequence SET revision=revision+1 WHERE id=1 RETURNING revision",
      )
      .get();
    return Number(row?.revision);
  }
  save(input: { name: string; description: string; assignment: SecretAssignment }): UserSecretMeta {
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO secrets_meta(name,description,assignment_json,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET description=excluded.description,
      assignment_json=excluded.assignment_json,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(
        input.name,
        input.description,
        JSON.stringify(input.assignment),
        this.nextRevision(),
        now,
        now,
      );
    return this.get(input.name) as UserSecretMeta;
  }
  remove(name: string): number {
    this.db.prepare("DELETE FROM secrets_meta WHERE name=?").run(name);
    return this.nextRevision();
  }
  revoke(name: string): void {
    this.db
      .prepare(`UPDATE grants SET revoked_at=? WHERE revoked_at IS NULL
      AND json_extract(scope,'$.kind')='secret' AND json_extract(scope,'$.name')=?`)
      .run(new Date().toISOString(), name);
  }
}
