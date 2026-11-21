import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { IdSchema } from "@pibot/skills-contract/full";
import { parseSkillRecord, type SkillRecord, skillColumns } from "./skills.ts";

export interface BuiltinState {
  digest: string | null;
  version: number | null;
  modified: boolean;
  keptVersion?: number | null;
  updatedVersion?: number | null;
}

/**
 * Built-in methods are own skill rows carrying the method key. Only the trusted
 * built-in sync binds a key; deleting a method records a removal so the sync does not put it back.
 */
export class BuiltinSkillsRepo {
  private readonly table: "skills" | "group_member_skills";
  constructor(
    private readonly db: DatabaseSync,
    private readonly groupId?: string,
  ) {
    this.table = groupId ? "group_member_skills" : "skills";
  }
  private scope() {
    return this.groupId ? { sql: " AND group_id=?", args: [this.groupId] } : { sql: "", args: [] };
  }
  private get removalScope() {
    return this.groupId ?? "";
  }
  get(botId: string, key: string): SkillRecord | undefined {
    const scope = this.scope();
    const row = this.db
      .prepare(`SELECT ${skillColumns} FROM ${this.table}
        WHERE bot_id=? AND builtin_key=? AND archived_at IS NULL${scope.sql}`)
      .get(botId, key, ...scope.args);
    return row ? parseSkillRecord(row) : undefined;
  }
  keys(botId: string, after = ""): string[] {
    const scope = this.scope();
    return this.db
      .prepare(`SELECT builtin_key FROM ${this.table}
      WHERE bot_id=? AND builtin_key>? AND archived_at IS NULL${scope.sql}
      ORDER BY builtin_key LIMIT 50`)
      .all(botId, after, ...scope.args)
      .map((row) => String(row.builtin_key));
  }
  bind(id: string, key: string, state: BuiltinState) {
    this.update(id, { builtin_key: key, builtin_merge_pending: 0, ...this.columns(state) });
  }
  setState(id: string, state: Partial<BuiltinState>) {
    this.update(id, this.columns(state));
  }
  private columns(state: Partial<BuiltinState>): Record<string, SQLInputValue> {
    const columns: Record<string, SQLInputValue> = {};
    if (state.digest !== undefined) columns.builtin_digest = state.digest;
    if (state.version !== undefined) columns.builtin_version = state.version;
    if (state.modified !== undefined) columns.builtin_modified = state.modified ? 1 : 0;
    if (state.keptVersion !== undefined) columns.builtin_kept_version = state.keptVersion;
    if (state.updatedVersion !== undefined) columns.builtin_updated_version = state.updatedVersion;
    return columns;
  }
  // Column names come from this file only, never from input.
  private update(id: string, columns: Record<string, SQLInputValue>) {
    const names = Object.keys(columns);
    if (!names.length) return;
    const scope = this.scope();
    this.db
      .prepare(
        `UPDATE ${this.table} SET ${names.map((name) => `${name}=?`).join(",")} WHERE id=?${scope.sql}`,
      )
      .run(...names.map((name) => columns[name] ?? null), IdSchema.parse(id), ...scope.args);
  }
  /**
   * Rows that may be another copy of method `key`: team-template copies and 「复制为我的」 copies
   * (taught). Narrowed by folder or name here; the caller decides from the files whether a row
   * really is the method. 0101 queued the rows that existed then; a method added to the shipped
   * list later still finds its copies, so the sync binds them instead of installing a
   * second copy under a numbered name.
   */
  mergeCandidates(botId: string, key: string, name: string): SkillRecord[] {
    const scope = this.scope();
    const prefix = `${name.replace(/[\\%_]/g, (c) => `\\${c}`)} %`;
    return this.db
      .prepare(`SELECT ${skillColumns} FROM ${this.table}
        WHERE bot_id=? AND builtin_key IS NULL AND archived_at IS NULL
          AND source IN ('team','taught')
          AND (path=? OR path LIKE ? ESCAPE '\\' OR name=? COLLATE NOCASE OR name LIKE ? ESCAPE '\\')${scope.sql}
        ORDER BY created_at,id LIMIT 20`)
      .all(botId, `skills/${key}`, `skills/${key}-%`, name, prefix, ...scope.args)
      .map(parseSkillRecord);
  }
  clearPending(id: string) {
    const scope = this.scope();
    this.db
      .prepare(
        `UPDATE ${this.table} SET builtin_merge_pending=0
         WHERE id=? AND builtin_merge_pending=1${scope.sql}`,
      )
      .run(IdSchema.parse(id), ...scope.args);
  }
  /** A merged-away duplicate: disabled and hidden, its row and folder kept (never deleted). */
  archive(id: string) {
    this.update(id, {
      builtin_key: null,
      builtin_merge_pending: 0,
      enabled: 0,
      archived_at: new Date().toISOString(),
    });
  }
  carryLastUsed(id: string, lastUsedAt: string) {
    const scope = this.scope();
    this.db
      .prepare(`UPDATE ${this.table} SET last_used_at=?
        WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)${scope.sql}`)
      .run(lastUsedAt, IdSchema.parse(id), lastUsedAt, ...scope.args);
  }
  /**
   * A group overrides a member's own Bot skills once the user set anything for it there —
   * an own skill, an edited, disabled or deleted method. Unchanged methods alone do not, so the
   * member keeps its other Bot skills in a group nobody customized.
   */
  hasOwn(botId: string): boolean {
    const scope = this.scope();
    return (
      !!this.db
        .prepare(`SELECT 1 FROM ${this.table}
          WHERE bot_id=? AND archived_at IS NULL
            AND (builtin_key IS NULL OR builtin_modified=1 OR enabled=0)${scope.sql} LIMIT 1`)
        .get(botId, ...scope.args) ||
      (!!this.groupId &&
        !!this.db
          .prepare("SELECT 1 FROM builtin_skill_removals WHERE scope=? AND bot_id=? LIMIT 1")
          .get(this.removalScope, botId))
    );
  }
  removed(botId: string, key: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM builtin_skill_removals WHERE scope=? AND bot_id=? AND builtin_key=?")
      .get(this.removalScope, botId, key);
  }
  markRemoved(botId: string, key: string) {
    this.db
      .prepare(`INSERT INTO builtin_skill_removals(scope,bot_id,builtin_key,removed_at)
        VALUES (?,?,?,?) ON CONFLICT DO NOTHING`)
      .run(this.removalScope, botId, key, new Date().toISOString());
  }
  /** The person gave this method back to the Bot from the connections page. */
  unmarkRemoved(botId: string, key: string) {
    this.db
      .prepare("DELETE FROM builtin_skill_removals WHERE scope=? AND bot_id=? AND builtin_key=?")
      .run(this.removalScope, botId, key);
  }
}
