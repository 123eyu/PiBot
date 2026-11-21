import type { DatabaseSync } from "node:sqlite";
import {
  type SkillUpdatePending,
  SkillUpdatePendingSchema,
  type SkillUpdatePrevious,
  SkillUpdatePreviousSchema,
} from "@pibot/skills-contract/full";

/** Which table the skill lives in: both use their own id space. */
export type SkillUpdateScope = "bot" | "group";
export type SkillUpdateRecord = {
  sourceVersion: string | null;
  digest: string;
  importedAt: string;
  checkedAt: string | null;
  /** Downloaded and waiting for the user's answer; kept from cleanup in the meantime. */
  pending?: SkillUpdatePending;
  /** The package the last update replaced, kept 7 days by the shared-package retention. */
  previous?: SkillUpdatePrevious;
};
export function updateKey(scope: SkillUpdateScope, skillId: string) {
  return `${scope}:${skillId}`;
}
/**
 * A row written by another build (or half-written) must not break the skill detail; unusable JSON
 * reads as "no update state" and the next check writes a fresh value.
 */
function stored<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown,
) {
  if (value == null) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(String(value)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
export class SkillUpdatesRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(scope: SkillUpdateScope, skillId: string): SkillUpdateRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT source_version,digest,imported_at,checked_at,pending,previous FROM skill_updates WHERE id=?",
      )
      .get(updateKey(scope, skillId));
    if (!row) return undefined;
    const pending = stored<SkillUpdatePending>(SkillUpdatePendingSchema, row.pending);
    const previous = stored<SkillUpdatePrevious>(SkillUpdatePreviousSchema, row.previous);
    return {
      sourceVersion: row.source_version == null ? null : String(row.source_version),
      digest: String(row.digest),
      importedAt: String(row.imported_at),
      checkedAt: row.checked_at == null ? null : String(row.checked_at),
      ...(pending ? { pending } : {}),
      ...(previous ? { previous } : {}),
    };
  }
  put(scope: SkillUpdateScope, skillId: string, record: SkillUpdateRecord, at: string): void {
    this.db
      .prepare(
        `INSERT INTO skill_updates(id,source_version,digest,imported_at,checked_at,pending_package_id,pending,previous_package_id,previous,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET source_version=excluded.source_version,digest=excluded.digest,
           imported_at=excluded.imported_at,checked_at=excluded.checked_at,
           pending_package_id=excluded.pending_package_id,pending=excluded.pending,
           previous_package_id=excluded.previous_package_id,previous=excluded.previous,
           updated_at=excluded.updated_at`,
      )
      .run(
        updateKey(scope, skillId),
        record.sourceVersion,
        record.digest,
        record.importedAt,
        record.checkedAt,
        record.pending?.packageId ?? null,
        record.pending ? JSON.stringify(SkillUpdatePendingSchema.parse(record.pending)) : null,
        record.previous?.packageId ?? null,
        record.previous ? JSON.stringify(SkillUpdatePreviousSchema.parse(record.previous)) : null,
        at,
      );
  }
  remove(scope: SkillUpdateScope, skillId: string): void {
    this.db.prepare("DELETE FROM skill_updates WHERE id=?").run(updateKey(scope, skillId));
  }
}
