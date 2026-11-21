import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  IdSchema,
  type KnowledgeAccount,
  KnowledgeAccountSchema,
  type KnowledgeConfig,
  KnowledgeConfigSchema,
  type KnowledgeKind,
  KnowledgeKindSchema,
  KnowledgeNameSchema,
  KnowledgePageSchema,
  type KnowledgeSource,
  KnowledgeSourceSchema,
  type KnowledgeTargets,
  KnowledgeTargetsSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import { readPage, transaction } from "@pibot/storage";

type Row = Record<string, unknown>;

/** One source as the tools see it: the record the person manages, plus the reference it points at. */
export interface AssignedKnowledge {
  source: KnowledgeSource;
  config: KnowledgeConfig;
}

/** A source that vanished between the list render and the action: the UI refreshes the list. */
export function knowledgeMissing(): never {
  throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_source_missing");
}

function parseSource(row: Row, targets: KnowledgeTargets): KnowledgeSource {
  return KnowledgeSourceSchema.parse({
    id: row.id,
    kind: row.kind,
    name: row.name,
    targets: { ...targets, all: Number(row.targets_all) === 1 },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? null,
  });
}

export class KnowledgeRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(input: { before?: string; limit?: number } = {}) {
    const page = KnowledgePageSchema.parse(input);
    const rows = readPage(this.db, "knowledge_sources", "*", "created_at", {
      before: page.before,
      limit: page.limit + 1,
    });
    const shown = rows.slice(0, page.limit);
    const targets = this.targetsOf(shown.map((row) => String(row.id)));
    const items = shown.map((row) =>
      parseSource(row, targets.get(String(row.id)) ?? emptyTargets()),
    );
    return { items, nextBefore: rows.length > page.limit ? (items.at(-1)?.id ?? null) : null };
  }

  get(id: string): KnowledgeSource | undefined {
    const row = this.db
      .prepare("SELECT * FROM knowledge_sources WHERE id=?")
      .get(IdSchema.parse(id));
    if (!row) return undefined;
    const targets = this.targetsOf([String(row.id)]).get(String(row.id)) ?? emptyTargets();
    return parseSource(row, targets);
  }

  /** The stored reference itself: a vault path or the connector that holds the Notion credential. */
  origin(id: string): KnowledgeConfig {
    const row = this.db
      .prepare("SELECT config_json FROM knowledge_sources WHERE id=?")
      .get(IdSchema.parse(id));
    if (!row) knowledgeMissing();
    return KnowledgeConfigSchema.parse(JSON.parse(String(row.config_json)));
  }

  /** The stored Notion account; a row that no longer parses reads as never read. */
  account(id: string): KnowledgeAccount | null {
    const row = this.db
      .prepare("SELECT account_json FROM knowledge_sources WHERE id=?")
      .get(IdSchema.parse(id));
    if (!row) knowledgeMissing();
    if (typeof row.account_json !== "string") return null;
    try {
      return KnowledgeAccountSchema.safeParse(JSON.parse(row.account_json)).data ?? null;
    } catch {
      // A damaged value is the same as none: the next open reads the account again.
      return null;
    }
  }

  setAccount(id: string, account: KnowledgeAccount | null): void {
    const value = account ? JSON.stringify(KnowledgeAccountSchema.parse(account)) : null;
    const result = this.db
      .prepare("UPDATE knowledge_sources SET account_json=? WHERE id=?")
      .run(value, IdSchema.parse(id));
    if (result.changes === 0) knowledgeMissing();
  }

  /**
   * Adding the same vault twice (double click, or picking the folder again) must not create a
   * second source: the canonical path is the identity for a local folder.
   */
  findObsidian(path: string): KnowledgeSource | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM knowledge_sources WHERE kind='obsidian' AND json_extract(config_json,'$.path')=?",
      )
      .get(path);
    if (!row) return undefined;
    return this.get(String(row.id));
  }

  /**
   * One Notion connection serves the person's whole workspace, so adding Notion again
   * returns the record that already points at a connection instead of a second installation.
   */
  findNotion(): { source: KnowledgeSource; connectorId: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT id FROM knowledge_sources WHERE kind='notion' ORDER BY created_at,id LIMIT 1",
      )
      .get();
    if (!row) return undefined;
    const id = String(row.id);
    const source = this.get(id);
    const config = this.origin(id);
    if (!source || config.kind !== "notion") return undefined;
    return { source, connectorId: config.connectorId };
  }

  /**
   * Keeps the record's name and assignments when the connection it pointed at was removed and
   * had to be recreated: the person's intent was the workspace, not one connector row.
   */
  repoint(id: string, config: KnowledgeConfig): KnowledgeSource {
    const parsed = IdSchema.parse(id);
    const next = KnowledgeConfigSchema.parse(config);
    return transaction(this.db, () => {
      const result = this.db
        .prepare(
          "UPDATE knowledge_sources SET config_json=?,account_json=NULL,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(next), new Date().toISOString(), parsed);
      if (result.changes === 0) knowledgeMissing();
      const updated = this.get(parsed);
      if (!updated) knowledgeMissing();
      return updated;
    });
  }

  create(input: {
    kind: KnowledgeKind;
    name: string;
    config: KnowledgeConfig;
    targets: KnowledgeTargets;
  }): KnowledgeSource {
    const kind = KnowledgeKindSchema.parse(input.kind);
    const name = KnowledgeNameSchema.parse(input.name);
    const config = KnowledgeConfigSchema.parse(input.config);
    const targets = KnowledgeTargetsSchema.parse(input.targets);
    return transaction(this.db, () => {
      const now = new Date().toISOString();
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO knowledge_sources(id,kind,name,config_json,targets_all,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(id, kind, name, JSON.stringify(config), targets.all ? 1 : 0, now, now);
      this.writeTargets(id, targets);
      const created = this.get(id);
      if (!created) knowledgeMissing();
      return created;
    });
  }

  update(input: { id: string; name: string; targets: KnowledgeTargets }): KnowledgeSource {
    const id = IdSchema.parse(input.id);
    const name = KnowledgeNameSchema.parse(input.name);
    const targets = KnowledgeTargetsSchema.parse(input.targets);
    return transaction(this.db, () => {
      const result = this.db
        .prepare("UPDATE knowledge_sources SET name=?, updated_at=? WHERE id=?")
        .run(name, new Date().toISOString(), id);
      if (result.changes === 0) knowledgeMissing();
      this.db.prepare("DELETE FROM knowledge_assignments WHERE source_id=?").run(id);
      this.writeTargets(id, targets);
      this.db
        .prepare("UPDATE knowledge_sources SET targets_all=?, updated_at=? WHERE id=?")
        .run(targets.all ? 1 : 0, new Date().toISOString(), id);
      const updated = this.get(id);
      if (!updated) knowledgeMissing();
      return updated;
    });
  }

  /** Forgets the source and its assignments; the vault and the Notion workspace stay untouched. */
  remove(id: string): void {
    const parsed = IdSchema.parse(id);
    transaction(this.db, () => {
      // Assignments first: the foreign key keeps a removed source from stranding rows.
      this.db.prepare("DELETE FROM knowledge_assignments WHERE source_id=?").run(parsed);
      const result = this.db.prepare("DELETE FROM knowledge_sources WHERE id=?").run(parsed);
      if (result.changes === 0) knowledgeMissing();
    });
  }

  private writeTargets(id: string, targets: KnowledgeTargets): void {
    if (targets.all) return;
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO knowledge_assignments(source_id,target_kind,target_id) VALUES(?,?,?)",
    );
    for (const botId of targets.bots) insert.run(id, "bot", IdSchema.parse(botId));
    for (const groupId of targets.groups) insert.run(id, "group", IdSchema.parse(groupId));
  }

  /**
   * What the two knowledge tools may open for this run. Assignment is the authorization
   * the person granted in the knowledge tab, so it is read per call rather than cached: revoking
   * a source must stop the next tool call, not the next run.
   */
  assigned(input: { botId: string; groupId?: string }): AssignedKnowledge[] {
    const botId = IdSchema.parse(input.botId);
    const groupId = input.groupId ? IdSchema.parse(input.groupId) : undefined;
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_sources WHERE id IN (
          SELECT id FROM knowledge_sources WHERE targets_all=1
          UNION
          SELECT source_id FROM knowledge_assignments WHERE target_kind='bot' AND target_id=?
          ${groupId ? "UNION SELECT source_id FROM knowledge_assignments WHERE target_kind='group' AND target_id=?" : ""}
        ) ORDER BY created_at,id`,
      )
      .all(...(groupId ? [botId, groupId] : [botId]));
    if (rows.length === 0) return [];
    const targets = this.targetsOf(rows.map((row) => String(row.id)));
    return rows.map((row) => ({
      source: parseSource(row, targets.get(String(row.id)) ?? emptyTargets()),
      config: KnowledgeConfigSchema.parse(JSON.parse(String(row.config_json))),
    }));
  }

  /** Last use is the only feedback the knowledge tab shows about a source being read. */
  markUsed(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const parsed = ids.slice(0, 20).map((id) => IdSchema.parse(id));
    this.db
      .prepare(
        `UPDATE knowledge_sources SET last_used_at=? WHERE id IN (${parsed.map(() => "?").join(",")})`,
      )
      .run(new Date().toISOString(), ...parsed);
  }

  /** One query per page instead of one per row: the list is the hot path of the knowledge tab. */
  private targetsOf(ids: string[]): Map<string, KnowledgeTargets> {
    const map = new Map<string, KnowledgeTargets>();
    if (ids.length === 0) return map;
    const rows = this.db
      .prepare(
        `SELECT source_id,target_kind,target_id FROM knowledge_assignments
        WHERE source_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids);
    for (const row of rows) {
      const key = String(row.source_id);
      const entry = map.get(key) ?? emptyTargets();
      if (row.target_kind === "bot") entry.bots.push(String(row.target_id));
      else entry.groups.push(String(row.target_id));
      map.set(key, entry);
    }
    return map;
  }
}

function emptyTargets(): KnowledgeTargets {
  return { all: false, bots: [], groups: [] };
}
