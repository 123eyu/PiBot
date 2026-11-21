import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  IdSchema,
  type SkillCatalogItem,
  SkillCatalogItemSchema,
} from "@pibot/skills-contract/full";

const ORIGIN_TOOLS = new Set(["claude-code", "codex", "cursor", "pi", "opencode"]);
/** Upper bound of copies folded into one row; more Bots than this is far past the UI's limit. */
const MAX_COPIES = 500;

interface Copy {
  id: string;
  bot: string;
  group: string | null;
  enabled: number;
  source: string;
  builtin: string | null;
  origin: string | null;
}

// Live skills of live Bots, private and per-group. ASCII `lower()` matches the NOCASE uniqueness
// the stores already use for names; non-ASCII names merge only when written the same way.
const COPIES = `SELECT s.id, s.bot_id AS bot, NULL AS grp, s.name, s.description, s.enabled,
    s.source, s.builtin_key AS builtin, s.origin_tool AS origin
  FROM skills s JOIN bots b ON b.id=s.bot_id
  WHERE s.archived_at IS NULL AND b.archived_at IS NULL
  UNION ALL
  SELECT s.id, s.bot_id, s.group_id, s.name, s.description, s.enabled,
    s.source, s.builtin_key, NULL
  FROM group_member_skills s JOIN bots b ON b.id=s.bot_id JOIN groups g ON g.id=s.group_id
  WHERE s.archived_at IS NULL AND b.archived_at IS NULL AND g.archived_at IS NULL
    AND EXISTS (SELECT 1 FROM group_members m
      WHERE m.group_id=s.group_id AND m.bot_id=s.bot_id AND m.left_at IS NULL)`;

/**
 * The position is (lower(name), smallest copy id), both bounded — a cursor built from the
 * description grew past the 400-character contract limit at 700+ characters and made every
 * catalog read fail validation. Version 2 is explicit so a cursor issued before this change is
 * rejected and the caller gets the first page instead of a page somewhere in the middle.
 */
function encodeCursor(name: string, id: string) {
  return Buffer.from(JSON.stringify([2, name, id])).toString("base64url");
}
function decodeCursor(cursor: string): [string, string] | undefined {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(value) &&
      value.length === 3 &&
      value[0] === 2 &&
      typeof value[1] === "string" &&
      typeof value[2] === "string"
      ? [value[1], value[2]]
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every skill the Bots and groups have, one row per name + description (a role method
 * installed in five Bots is one row). Paged in SQL by that key, so a large library is never read
 * whole; each row carries who has an enabled copy.
 */
export class SkillCatalogRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Only distinct installed method keys cross into the label reader, never whole skill rows. */
  builtinKeys(): string[] {
    return this.db
      .prepare(`SELECT DISTINCT builtin FROM (${COPIES}) WHERE builtin IS NOT NULL`)
      .all()
      .map((row) => String(row.builtin));
  }

  /** Role labels depend on the owner; read only live metadata in bounded batches. */
  *roleCopies() {
    let after = ["", ""];
    const read = this.db.prepare(`SELECT id, bot, grp, name, description FROM (${COPIES})
      WHERE source='team' AND builtin IS NULL AND (coalesce(grp, ''), id) > (?, ?)
      ORDER BY coalesce(grp, ''), id LIMIT 100`);
    while (true) {
      const rows = read.all(...after);
      for (const row of rows) {
        after = [String(row.grp ?? ""), String(row.id)];
        yield {
          id: String(row.id),
          botId: String(row.bot),
          groupId: row.grp == null ? undefined : String(row.grp),
          name: String(row.name),
          description: String(row.description),
        };
      }
      if (rows.length < 100) return;
    }
  }

  page(
    input: { cursor?: string; limit: number; query?: string },
    matchingBuiltinKeys: readonly string[] = [],
    matchingRoleCopyIds: readonly string[] = [],
  ): {
    items: SkillCatalogItem[];
    nextCursor: string | null;
    total: number;
  } {
    const filters: string[] = [];
    const args: SQLInputValue[] = [];
    const query = input.query?.trim();
    if (query) {
      // Match the whole aggregate: filtering individual copies would hide assignments of a
      // non-built-in copy that shares this row's name and description with a matched method.
      filters.push(`max(instr(lower(name), lower(?)) > 0 OR
        instr(lower(description), lower(?)) > 0 OR
        builtin IN (SELECT value FROM json_each(?)) OR
        id IN (SELECT value FROM json_each(?))) > 0`);
      args.push(
        query,
        query,
        JSON.stringify(matchingBuiltinKeys),
        JSON.stringify(matchingRoleCopyIds),
      );
    }
    const matched = filters.length ? `HAVING ${filters.join(" AND ")}` : "";
    const total = Number(
      this.db
        .prepare(
          `SELECT count(*) AS n FROM (SELECT 1 FROM (${COPIES}) GROUP BY lower(name), description ${matched})`,
        )
        .get(...args)?.n ?? 0,
    );
    const after = input.cursor ? decodeCursor(input.cursor) : undefined;
    if (after) filters.push("(lower(name), min(id)) > (?, ?)");
    const having = filters.length ? `HAVING ${filters.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT lower(name) AS k, min(id) AS rowId, description, min(name) AS name,
          json_group_array(json_object('id',id,'bot',bot,'group',grp,'enabled',enabled,
            'source',source,'builtin',builtin,'origin',origin)) AS copies
        FROM (${COPIES})
        GROUP BY lower(name), description ${having}
        ORDER BY lower(name), min(id) LIMIT ?`,
      )
      .all(...args, ...(after ?? []), input.limit + 1);
    const more = rows.length > input.limit;
    const items = rows
      .slice(0, input.limit)
      .map((row) =>
        this.item(
          String(row.name),
          String(row.description),
          (JSON.parse(String(row.copies)) as Copy[]).slice(0, MAX_COPIES),
        ),
      );
    const last = rows[input.limit - 1];
    return {
      items,
      nextCursor: more && last ? encodeCursor(String(last.k), String(last.rowId)) : null,
      total,
    };
  }

  private item(name: string, description: string, copies: Copy[]): SkillCatalogItem {
    const bots = new Set<string>();
    const groups = new Set<string>();
    for (const copy of copies) {
      if (!copy.enabled) continue;
      if (copy.group) groups.add(copy.group);
      else bots.add(copy.bot);
    }
    // A private enabled copy opens best: it is what the Bot actually runs outside groups.
    const representative =
      copies.find((copy) => copy.enabled && !copy.group) ??
      copies.find((copy) => !copy.group) ??
      copies[0];
    if (!representative) throw new Error("Catalog row without a copy");
    const originTool = copies.find((copy) => copy.origin && ORIGIN_TOOLS.has(copy.origin))?.origin;
    // The brain fills the labels for both languages from this key; the rows only know the
    // language each copy was installed in.
    const builtinKey = copies.find((copy) => copy.builtin)?.builtin;
    return SkillCatalogItemSchema.parse({
      key: createHash("sha256")
        .update(`${name.toLowerCase()}\0${description}`)
        .digest("hex")
        .slice(0, 32),
      skillId: representative.id,
      botId: representative.bot,
      ...(representative.group ? { groupId: representative.group } : {}),
      name,
      description,
      origin: copies.some((copy) => copy.builtin) ? "builtin" : representative.source,
      ...(builtinKey ? { builtinKey } : {}),
      ...(originTool ? { originTool } : {}),
      bots: [...bots],
      groups: [...groups],
      copies: copies.length,
    });
  }

  /**
   * Every copy (Bots' own and every group's) of the catalog row `skillId` represents, by the
   * same name + description key and live-row filter as `page`. `groupId` says which store
   * `skillId` lives in: once the Bots' copies are gone the row is represented by a group copy,
   * whose id the private table does not have. Built-in copies are reported, never deleted here.
   */
  copies(
    skillId: string,
    groupId?: string,
  ): { copies: { id: string; groupId: string | null }[]; builtin: boolean } {
    const id = IdSchema.parse(skillId);
    const row = groupId
      ? this.db
          .prepare(
            "SELECT name, description FROM group_member_skills WHERE id=? AND group_id=? AND archived_at IS NULL",
          )
          .get(id, IdSchema.parse(groupId))
      : this.db
          .prepare("SELECT name, description FROM skills WHERE id=? AND archived_at IS NULL")
          .get(id);
    if (!row) return { copies: [], builtin: false };
    const rows = this.db
      .prepare(
        `SELECT id, grp, builtin FROM (${COPIES})
        WHERE lower(name)=lower(?) AND description=? LIMIT ?`,
      )
      .all(String(row.name), String(row.description), MAX_COPIES);
    return {
      copies: rows.map((copy) => ({
        id: String(copy.id),
        groupId: copy.grp == null ? null : String(copy.grp),
      })),
      builtin: rows.some((copy) => copy.builtin != null),
    };
  }

  /**
   * Names in use by any Bot's own or group skills (lower-cased) and the scan keys of everything
   * brought over, bounded, for marking clashes in a scan.
   */
  known(): { names: Set<string>; originKeys: Set<string> } {
    const names = new Set<string>();
    for (const row of this.db
      .prepare(
        `SELECT name FROM skills WHERE archived_at IS NULL
         UNION SELECT name FROM group_member_skills WHERE archived_at IS NULL LIMIT 10000`,
      )
      .all())
      names.add(String(row.name).toLowerCase());
    const originKeys = new Set(
      this.db
        .prepare(
          "SELECT DISTINCT origin_key AS key FROM skills WHERE origin_key IS NOT NULL LIMIT 10000",
        )
        .all()
        .map((row) => String(row.key)),
    );
    return { names, originKeys };
  }

  /** A clashing name gets " 2", " 3"…, checked against every Bot so a later copy never clashes. */
  freeName(name: string): string {
    const taken = this.db.prepare(
      `SELECT 1 FROM skills WHERE name=? COLLATE NOCASE AND archived_at IS NULL
       UNION ALL SELECT 1 FROM group_member_skills WHERE name=? COLLATE NOCASE AND archived_at IS NULL
       LIMIT 1`,
    );
    if (!taken.get(name, name)) return name;
    for (let n = 2; n < 100; n++) {
      const suffix = ` ${n}`;
      const candidate = `${name.slice(0, 80 - suffix.length)}${suffix}`;
      if (!taken.get(candidate, candidate)) return candidate;
    }
    throw new TypeError("Skill name exists");
  }

  /** Recorded in the creating transaction, so a brought-over skill never appears unlabelled. */
  setOrigin(skillId: string, origin: { tool: string; key: string }) {
    if (!ORIGIN_TOOLS.has(origin.tool)) throw new TypeError("Unknown origin tool");
    this.db
      .prepare("UPDATE skills SET origin_tool=?,origin_key=? WHERE id=?")
      .run(origin.tool, origin.key.slice(0, 128), IdSchema.parse(skillId));
  }

  /** The origin a private copy carries, so a copy given to another Bot keeps its label. */
  origin(skillId: string): { tool: string; key: string } | undefined {
    const row = this.db
      .prepare("SELECT origin_tool AS tool, origin_key AS key FROM skills WHERE id=?")
      .get(IdSchema.parse(skillId));
    return row?.tool == null || row.key == null
      ? undefined
      : { tool: String(row.tool), key: String(row.key) };
  }
}
