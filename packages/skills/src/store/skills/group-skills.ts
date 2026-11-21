import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  IdSchema,
  type Page,
  SkillDescriptionSchema,
  SkillDirSchema,
  SkillImportSourceSchema,
  SkillNameSchema,
  SkillSchema,
  SkillSourceSchema,
} from "@pibot/skills-contract/full";
import { readPage, transaction } from "@pibot/storage";
import {
  type CreateSkill,
  MAX_PROMPT_SKILLS,
  packageIdOf,
  parseSkillRecord,
  type SkillListQuery,
  type SkillRecord,
  type SkillRepository,
  skillColumns,
  skillListFilters,
} from "./skills.ts";
export class GroupSkillsRepo implements SkillRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly groupId: string,
  ) {}

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
      .prepare(`INSERT INTO group_member_skills(group_id,id,bot_id,name,description,source,enabled,path,package_id,import_source,last_used_at,
        created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?)`)
      .run(
        this.groupId,
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

  /** Only the brain's plan save path calls this, inside the creating transaction. */
  markSavedFromPlan(id: string, workflowRunId: string) {
    this.db
      .prepare("UPDATE group_member_skills SET saved_plan_run_id=? WHERE group_id=? AND id=?")
      .run(IdSchema.parse(workflowRunId), this.groupId, IdSchema.parse(id));
  }

  savedPlanExists(workflowRunId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM group_member_skills WHERE group_id=? AND saved_plan_run_id=? AND archived_at IS NULL LIMIT 1",
      )
      .get(this.groupId, IdSchema.parse(workflowRunId));
  }

  get(id: string): SkillRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT ${skillColumns} FROM group_member_skills WHERE group_id=? AND id=? AND archived_at IS NULL`,
      )
      .get(this.groupId, IdSchema.parse(id));
    return row ? parseSkillRecord(row) : undefined;
  }

  findByName(botId: string, name: string): SkillRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT ${skillColumns} FROM group_member_skills WHERE group_id=? AND bot_id=? AND name=? COLLATE NOCASE AND archived_at IS NULL`,
      )
      .get(this.groupId, IdSchema.parse(botId), SkillNameSchema.parse(name));
    return row ? parseSkillRecord(row) : undefined;
  }

  /** The skill whose folder is `path` (`skills/<slug>`), e.g. to mark it used when its file is read. */
  findByPath(botId: string, path: string): SkillRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT ${skillColumns} FROM group_member_skills WHERE group_id=? AND bot_id=? AND path=? AND archived_at IS NULL`,
      )
      .get(this.groupId, IdSchema.parse(botId), SkillDirSchema.parse(path));
    return row ? parseSkillRecord(row) : undefined;
  }

  pathTaken(botId: string, path: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM group_member_skills WHERE group_id=? AND bot_id=? AND path=?")
      .get(this.groupId, IdSchema.parse(botId), SkillDirSchema.parse(path));
  }

  list(botId: string, query: SkillListQuery = {}, page: Page = {}): SkillRecord[] {
    const scope: [string, string | number][] = [
      ["group_id", this.groupId],
      ["bot_id", IdSchema.parse(botId)],
    ];
    const filters = [...scope, ...skillListFilters(query)];
    return readPage(
      this.db,
      "group_member_skills",
      skillColumns,
      "created_at",
      page,
      filters,
      scope,
    ).map(parseSkillRecord);
  }

  /** Enabled skills for the system prompt, in a stable order independent of creation time. */
  enabledForPrompt(botId: string): SkillRecord[] {
    return this.db
      .prepare(
        `SELECT ${skillColumns} FROM group_member_skills WHERE group_id=? AND bot_id=? AND enabled=1 AND archived_at IS NULL ORDER BY name,id LIMIT ?`,
      )
      .all(this.groupId, IdSchema.parse(botId), MAX_PROMPT_SKILLS)
      .map(parseSkillRecord);
  }

  /** Every skill of a Bot for a `.pibot` v2 export (enabled or not); bounded like the file format. */
  forExport(botId: string): SkillRecord[] {
    return this.db
      .prepare(
        `SELECT ${skillColumns} FROM group_member_skills WHERE group_id=? AND bot_id=? AND archived_at IS NULL ORDER BY name,id LIMIT 100`,
      )
      .all(this.groupId, IdSchema.parse(botId))
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
        .prepare(
          "UPDATE group_member_skills SET name=?,description=?,updated_at=? WHERE group_id=? AND id=?",
        )
        .run(name, description, new Date().toISOString(), this.groupId, current.id);
      return this.get(current.id) as SkillRecord;
    });
  }

  /** Body edits change only files; this keeps `updatedAt` truthful for the list. */
  touchUpdated(id: string): void {
    this.db
      .prepare("UPDATE group_member_skills SET updated_at=? WHERE group_id=? AND id=?")
      .run(new Date().toISOString(), this.groupId, IdSchema.parse(id));
  }

  setPackage(id: string, packageId: string | undefined): void {
    this.db
      .prepare("UPDATE group_member_skills SET package_id=? WHERE group_id=? AND id=?")
      .run(packageId ? packageIdOf(packageId) : null, this.groupId, IdSchema.parse(id));
  }

  setEnabled(id: string, enabled: boolean): SkillRecord | undefined {
    this.db
      .prepare("UPDATE group_member_skills SET enabled=?,updated_at=? WHERE group_id=? AND id=?")
      .run(enabled ? 1 : 0, new Date().toISOString(), this.groupId, IdSchema.parse(id));
    return this.get(id);
  }

  markUsed(id: string, at = new Date()): void {
    this.db
      .prepare("UPDATE group_member_skills SET last_used_at=? WHERE group_id=? AND id=?")
      .run(at.toISOString(), this.groupId, IdSchema.parse(id));
  }

  /** Returns the removed record so brain can delete its folder after the row is gone. */
  remove(id: string): SkillRecord | undefined {
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return undefined;
      this.db
        .prepare("DELETE FROM group_member_skills WHERE group_id=? AND id=?")
        .run(this.groupId, current.id);
      return current;
    });
  }
}
