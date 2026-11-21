import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  IdSchema,
  type Page,
  type Skill,
  SkillDescriptionSchema,
  SkillDirSchema,
  type SkillImportSource,
  SkillImportSourceSchema,
  SkillNameSchema,
  SkillSchema,
  type SkillSource,
  SkillSourceSchema,
} from "@pibot/skills-contract/full";
import { readPage, transaction } from "@pibot/storage";

export function packageIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{16}$/.test(value))
    throw new TypeError("Invalid skill package");
  return value;
}

/** Store record; `path` stays in brain (relative to the Bot directory) and is never sent to UI. */
export type SkillRecord = Skill & {
  path: string;
  packageId?: string;
  importSource?: SkillImportSource;
  /** Built-in rows: the fingerprint of the version in `builtinState`, and 「保留我的」's version. */
  builtin?: { digest: string | null; keptVersion: number | null };
};
export interface SkillListQuery {
  enabled?: boolean;
  /** False = no built-in methods (what users see). */
  builtin?: false;
}
/** An archived row is a merged-away duplicate; it stays on disk but is never listed. */
export function skillListFilters(query: SkillListQuery): [string, SQLInputValue][] {
  const filters: [string, SQLInputValue][] = [["archived_at", null]];
  if (query.enabled !== undefined) filters.push(["enabled", query.enabled ? 1 : 0]);
  if (query.builtin === false) filters.push(["builtin_key", null]);
  return filters;
}
export const skillColumns = `builtin_key AS builtinKey,id,bot_id AS botId,name,description,source,enabled,path,package_id AS packageId,import_source AS importSource,last_used_at AS lastUsedAt,
  created_at AS createdAt,updated_at AS updatedAt,saved_plan_run_id AS savedPlanRunId,
  builtin_digest AS builtinDigest,builtin_version AS builtinVersion,builtin_modified AS builtinModified,
  builtin_kept_version AS builtinKeptVersion,builtin_updated_version AS builtinUpdatedVersion`;
const optionalInt = (value: unknown) => (value == null ? null : Number(value));
export function parseSkillRecord(row: Record<string, unknown>): SkillRecord {
  const {
    path,
    packageId,
    importSource,
    builtinKey,
    savedPlanRunId,
    builtinDigest,
    builtinVersion,
    builtinModified,
    builtinKeptVersion,
    builtinUpdatedVersion,
    ...fields
  } = row;
  const updatedTo = optionalInt(builtinUpdatedVersion);
  const skill = SkillSchema.parse({
    ...fields,
    ...(builtinKey == null
      ? {}
      : {
          builtinKey,
          builtinState: {
            version: optionalInt(builtinVersion),
            modified: builtinModified === 1,
            ...(updatedTo === null ? {} : { updatedTo }),
          },
        }),
    ...(savedPlanRunId == null ? {} : { savedFromPlan: { workflowRunId: savedPlanRunId } }),
    enabled: row.enabled === 1,
  });
  return {
    ...skill,
    path: SkillDirSchema.parse(path),
    ...(importSource == null
      ? {}
      : { importSource: SkillImportSourceSchema.parse(JSON.parse(String(importSource))) }),
    ...(packageId == null ? {} : { packageId: packageIdOf(packageId) }),
    ...(builtinKey == null
      ? {}
      : {
          builtin: {
            digest: builtinDigest == null ? null : String(builtinDigest),
            keptVersion: optionalInt(builtinKeptVersion),
          },
        }),
  };
}
export function toSkill({
  path: _path,
  packageId: _packageId,
  importSource: _importSource,
  builtin: _builtin,
  ...skill
}: SkillRecord): Skill {
  return skill;
}
/** Upper bound on skills rendered into one system prompt; keeps the prompt bounded. */
export const MAX_PROMPT_SKILLS = 100;

export type CreateSkill = {
  botId: string;
  name: string;
  description: string;
  source: SkillSource;
  enabled?: boolean;
  path: string;
  packageId?: string;
  importSource?: SkillImportSource;
};

export class SkillsRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateSkill): SkillRecord {
    return transaction(this.db, () => this.insert(input));
  }

  /**
   * Team import (`.pibot` v2) writes all of a Bot's skills or none. Name clashes fail the whole
   * batch rather than silently renaming, so the preview the user approved stays accurate.
   */
  createMany(inputs: CreateSkill[]): SkillRecord[] {
    if (inputs.length > 100) throw new TypeError("Too many skills");
    return transaction(this.db, () => inputs.map((input) => this.insert(input)));
  }

  private insert(input: CreateSkill): SkillRecord {
    const now = new Date().toISOString();
    const record: SkillRecord = {
      ...SkillSchema.parse({
        id: randomUUID(),
        botId: input.botId,
        name: input.name,
        description: input.description,
        source: SkillSourceSchema.parse(input.source),
        enabled: input.enabled ?? true,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      }),
      path: SkillDirSchema.parse(input.path),
      ...(input.packageId ? { packageId: packageIdOf(input.packageId) } : {}),
      ...(input.importSource
        ? { importSource: SkillImportSourceSchema.parse(input.importSource) }
        : {}),
    };
    if (this.findByName(record.botId, record.name)) throw new TypeError("Skill name exists");
    this.db
      .prepare(`INSERT INTO skills(id,bot_id,name,description,source,enabled,path,package_id,import_source,last_used_at,
        created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?)`)
      .run(
        record.id,
        record.botId,
        record.name,
        record.description,
        record.source,
        record.enabled ? 1 : 0,
        record.path,
        record.packageId ?? null,
        record.importSource ? JSON.stringify(record.importSource) : null,
        now,
        now,
      );
    return record;
  }

  get(id: string): SkillRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${skillColumns} FROM skills WHERE id=? AND archived_at IS NULL`)
      .get(IdSchema.parse(id));
    return row ? parseSkillRecord(row) : undefined;
  }

  findByName(botId: string, name: string): SkillRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT ${skillColumns} FROM skills WHERE bot_id=? AND name=? COLLATE NOCASE AND archived_at IS NULL`,
      )
      .get(IdSchema.parse(botId), SkillNameSchema.parse(name));
    return row ? parseSkillRecord(row) : undefined;
  }

  /** The skill whose folder is `path` (`skills/<slug>`), e.g. to mark it used when its file is read. */
  findByPath(botId: string, path: string): SkillRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT ${skillColumns} FROM skills WHERE bot_id=? AND path=? AND archived_at IS NULL`,
      )
      .get(IdSchema.parse(botId), SkillDirSchema.parse(path));
    return row ? parseSkillRecord(row) : undefined;
  }

  pathTaken(botId: string, path: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM skills WHERE bot_id=? AND path=?")
      .get(IdSchema.parse(botId), SkillDirSchema.parse(path));
  }

  list(botId: string, query: SkillListQuery = {}, page: Page = {}): SkillRecord[] {
    const scope: [string, string | number][] = [["bot_id", IdSchema.parse(botId)]];
    const filters = [...scope, ...skillListFilters(query)];
    return readPage(this.db, "skills", skillColumns, "created_at", page, filters, scope).map(
      parseSkillRecord,
    );
  }

  /** Enabled skills for the system prompt, in a stable order independent of creation time. */
  enabledForPrompt(botId: string): SkillRecord[] {
    return this.db
      .prepare(
        `SELECT ${skillColumns} FROM skills WHERE bot_id=? AND enabled=1 AND archived_at IS NULL ORDER BY name,id LIMIT ?`,
      )
      .all(IdSchema.parse(botId), MAX_PROMPT_SKILLS)
      .map(parseSkillRecord);
  }

  /** Every skill of a Bot for a `.pibot` v2 export (enabled or not); bounded like the file format. */
  forExport(botId: string): SkillRecord[] {
    return this.db
      .prepare(
        `SELECT ${skillColumns} FROM skills WHERE bot_id=? AND archived_at IS NULL ORDER BY name,id LIMIT 100`,
      )
      .all(IdSchema.parse(botId))
      .map(parseSkillRecord);
  }

  updateMeta(id: string, patch: { name?: string; description?: string }): SkillRecord {
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) throw new TypeError("Unknown skill");
      const name = patch.name === undefined ? current.name : SkillNameSchema.parse(patch.name);
      const description =
        patch.description === undefined
          ? current.description
          : SkillDescriptionSchema.parse(patch.description);
      const clash = this.findByName(current.botId, name);
      if (clash && clash.id !== current.id) throw new TypeError("Skill name exists");
      this.db
        .prepare("UPDATE skills SET name=?,description=?,updated_at=? WHERE id=?")
        .run(name, description, new Date().toISOString(), current.id);
      return this.get(current.id) as SkillRecord;
    });
  }

  /** Body edits change only files; this keeps `updatedAt` truthful for the list. */
  touchUpdated(id: string): void {
    this.db
      .prepare("UPDATE skills SET updated_at=? WHERE id=?")
      .run(new Date().toISOString(), IdSchema.parse(id));
  }

  setPackage(id: string, packageId: string | undefined): void {
    this.db
      .prepare("UPDATE skills SET package_id=? WHERE id=?")
      .run(packageId ? packageIdOf(packageId) : null, IdSchema.parse(id));
  }

  setEnabled(id: string, enabled: boolean): SkillRecord | undefined {
    this.db
      .prepare("UPDATE skills SET enabled=?,updated_at=? WHERE id=?")
      .run(enabled ? 1 : 0, new Date().toISOString(), IdSchema.parse(id));
    return this.get(id);
  }

  markUsed(id: string, at = new Date()): void {
    this.db
      .prepare("UPDATE skills SET last_used_at=? WHERE id=?")
      .run(at.toISOString(), IdSchema.parse(id));
  }

  /** Returns the removed record so brain can delete its folder after the row is gone. */
  remove(id: string): SkillRecord | undefined {
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return undefined;
      this.db.prepare("DELETE FROM skills WHERE id=?").run(current.id);
      return current;
    });
  }
}

export type SkillRepository = Pick<SkillsRepo, keyof SkillsRepo>;
