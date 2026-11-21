import type { DatabaseSync } from "node:sqlite";
import { botNameKey, freeBotName } from "@pibot/protocol-base";
import { migrateMemorySearch } from "../bots/memory-search.ts";
import { migrateScopedMemory } from "./memory-migration.ts";

/**
 * Bots named alike before names had to be unique. Among non-archived Bots
 * the first one keeps its name (the main Bot first, then by created_at) and each later one becomes
 * 「name 2」, 「name 3」…, skipping any name another active Bot already has. Only `bots.name`
 * changes; updated_at and everything else stay. A second run finds nothing to rename.
 */
function uniqueBotNames(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT id, name FROM bots WHERE archived_at IS NULL ORDER BY is_main DESC, created_at, rowid",
    )
    .all()
    .map((row) => ({ id: String(row.id), name: String(row.name) }));
  // Every current name stays reserved so a renamed Bot never takes a later Bot's own name.
  const taken = new Set(rows.map((row) => botNameKey(row.name)));
  const kept = new Set<string>();
  const rename = db.prepare("UPDATE bots SET name=? WHERE id=?");
  for (const row of rows) {
    const key = botNameKey(row.name);
    if (!kept.has(key)) {
      kept.add(key);
      continue;
    }
    const name = freeBotName(row.name, taken);
    taken.add(botNameKey(name));
    rename.run(name, row.id);
  }
}

/**
 * Data changes SQL cannot express (Unicode folding), named by a `-- pibot:step <name>` first line
 * in the migration file and run inside that migration's transaction.
 */
export const migrationSteps: Readonly<Record<string, (db: DatabaseSync) => void>> = {
  "memory-search": migrateMemorySearch,
  "scoped-memory": migrateScopedMemory,
  "unique-bot-names": uniqueBotNames,
};
