import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MemorySchema } from "@pibot/protocol-base";

type Row = Record<string, unknown>;
const normalized = (text: string) =>
  text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

/** Keep IDs and original provenance; only exact normalized about-you duplicates share a row. */
export function migrateScopedMemory(db: DatabaseSync) {
  const mapping = new Map<string, string>();
  const canonical = new Map<string, string>();
  const audit = (row: Row, source: string, targetId: string) => {
    db.prepare(
      "INSERT INTO audit_log(id,at,bot_id,kind,summary,detail,run_id) VALUES(?,?,?,'memory.changed',?,?,NULL)",
    ).run(
      randomUUID(),
      new Date().toISOString(),
      String(row.bot_id),
      "Memory scope migrated / 记忆范围已迁移",
      JSON.stringify({
        reasonCode: "memory_scope_migrated",
        toolName: source,
        target: `${row.id}->${targetId}`,
      }),
    );
  };
  for (const table of ["memories", "group_memories"] as const) {
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY created_at,id`).all()) {
      const scope =
        table === "group_memories" ? "group" : row.category === "about_you" ? "user" : "bot";
      const owner =
        scope === "user" ? "user" : scope === "group" ? String(row.group_id) : String(row.bot_id);
      const key = scope === "user" ? normalized(String(row.text)) : undefined;
      const prior = key === undefined ? undefined : canonical.get(key);
      const id = prior ?? String(row.id);
      const source = { botId: String(row.bot_id), messageId: row.source_message_id ?? null };
      if (prior) {
        const saved = db.prepare("SELECT sources_json FROM scoped_memories WHERE id=?").get(id);
        const sources = JSON.parse(String(saved?.sources_json)) as unknown[];
        if (!sources.some((s) => JSON.stringify(s) === JSON.stringify(source)))
          sources.push(source);
        db.prepare("UPDATE scoped_memories SET sources_json=? WHERE id=?").run(
          JSON.stringify(sources),
          id,
        );
      } else {
        db.prepare(
          "INSERT INTO scoped_memories(id,scope,owner_id,bot_id,text,category,source_message_id,sources_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(
          id,
          scope,
          owner,
          String(row.bot_id),
          String(row.text),
          row.category as string | null,
          row.source_message_id as string | null,
          JSON.stringify([source]),
          String(row.created_at),
          String(row.updated_at),
        );
        if (key !== undefined) canonical.set(key, id);
      }
      mapping.set(`${table}:${row.id}`, id);
      if (prior)
        db.prepare("INSERT INTO memory_aliases(id,target_id) VALUES(?,?)").run(String(row.id), id);
      audit(row, table, id);
    }
  }
  const image = (value: unknown, groupId?: string): unknown => {
    if (!value || typeof value !== "object") return value;
    const row = value as Row;
    const scope = groupId ? "group" : row.category === "about_you" ? "user" : "bot";
    return MemorySchema.parse({
      ...row,
      category: row.category ?? null,
      id: mapping.get(`${groupId ? "group_memories" : "memories"}:${row.id}`) ?? row.id,
      scope,
      ownerId: scope === "user" ? "user" : (groupId ?? row.botId),
      sources: [{ botId: row.botId, messageId: row.sourceMessageId ?? null }],
    });
  };
  for (const table of ["memory_proposals", "group_memory_proposals"] as const) {
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY created_at,id`).all()) {
      const group = table === "group_memory_proposals";
      const memoryTable = group ? "group_memories" : "memories";
      const target = row.memory_id
        ? (mapping.get(`${memoryTable}:${row.memory_id}`) ?? String(row.memory_id))
        : null;
      const resolved = row.resolved_memory_id
        ? (mapping.get(`${memoryTable}:${row.resolved_memory_id}`) ?? null)
        : null;
      const existing = target
        ? db.prepare("SELECT scope,owner_id FROM scoped_memories WHERE id=?").get(target)
        : undefined;
      const scope = group
        ? "group"
        : (existing?.scope ?? (row.category === "about_you" ? "user" : "bot"));
      const owner = scope === "user" ? "user" : group ? String(row.group_id) : String(row.bot_id);
      const before = group
        ? image(JSON.parse(String(row.before_json)), String(row.group_id))
        : null;
      db.prepare(
        "INSERT INTO scoped_memory_proposals(id,scope,owner_id,bot_id,text,category,message_id,action,memory_id,resolved_memory_id,status,created_at,before_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        String(row.id),
        String(scope),
        owner,
        String(row.bot_id),
        String(row.text),
        row.category as string | null,
        row.message_id as string | null,
        String(row.action),
        target,
        resolved,
        String(row.status),
        String(row.created_at),
        group ? JSON.stringify(before) : null,
      );
      audit(row, table, String(row.id));
    }
  }
  for (const row of db
    .prepare("SELECT key,value FROM settings WHERE key LIKE 'memory-undo:%'")
    .all()) {
    const snapshot = JSON.parse(String(row.value));
    db.prepare("UPDATE settings SET value=? WHERE key=?").run(
      JSON.stringify({ ...snapshot, before: image(snapshot.before), after: image(snapshot.after) }),
      String(row.key),
    );
  }
  // Empty legacy tables avoid FK cascades mutating a second copy after migration.
  for (const table of [
    "memory_proposals",
    "group_memory_proposals",
    "memories",
    "group_memories",
  ]) {
    db.exec(`DELETE FROM ${table}`);
    for (const operation of ["INSERT", "UPDATE", "DELETE"])
      db.exec(
        `CREATE TRIGGER legacy_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Legacy memory table is read only'); END`,
      );
  }
  // Existing over-quota users migrate intact; only subsequent growth is restricted.
  for (const [name, operation, exclude] of [
    ["insert", "INSERT", ""],
    ["update", "UPDATE OF text,scope,owner_id", " AND id<>OLD.id"],
  ] as const) {
    db.exec(`CREATE TRIGGER scoped_memory_quota_${name} BEFORE ${operation} ON scoped_memories WHEN ${name === "update" ? "(NEW.scope<>OLD.scope OR NEW.owner_id<>OLD.owner_id OR length(NEW.text)>length(OLD.text)) AND (" : "("}
      (SELECT COUNT(*) FROM scoped_memories WHERE scope=NEW.scope AND owner_id=NEW.owner_id${exclude})>=100 OR
      (SELECT COALESCE(SUM(length(text)),0) FROM scoped_memories WHERE scope=NEW.scope AND owner_id=NEW.owner_id${exclude})+length(NEW.text)>8000)
      BEGIN SELECT RAISE(ABORT,'Memory quota exceeded'); END`);
  }
}
