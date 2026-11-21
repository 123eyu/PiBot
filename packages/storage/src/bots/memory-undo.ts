import type { DatabaseSync } from "node:sqlite";
import { IdSchema, type MemoryOwner, MemorySchema } from "@pibot/protocol-base";
import { z } from "zod";

// Only persisted pre-D63 snapshots may omit category; protocol results require it.
const legacyMemory = MemorySchema.extend({ category: MemorySchema.shape.category.default(null) });
const snapshot = z.strictObject({
  before: legacyMemory.nullable(),
  after: legacyMemory.nullable(),
  createdAt: z.iso.datetime(),
});
// A bounded persistent before/after image prevents undo from overwriting a newer edit.
export class MemoryUndoRepo {
  constructor(private readonly db: DatabaseSync) {}
  private key(botId: string, proposalId: string) {
    return `memory-undo:${IdSchema.parse(botId)}:${IdSchema.parse(proposalId)}`;
  }
  get(botId: string, proposalId: string) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(this.key(botId, proposalId));
    return row ? snapshot.parse(JSON.parse(String(row.value))) : undefined;
  }
  list(botId: string) {
    const prefix = `memory-undo:${IdSchema.parse(botId)}:`;
    return this.db
      .prepare(
        "SELECT key,value FROM settings WHERE key LIKE ? ORDER BY json_extract(value,'$.createdAt') DESC,rowid DESC LIMIT 100",
      )
      .all(`${prefix}%`)
      .map((row) => ({
        proposalId: IdSchema.parse(String(row.key).slice(prefix.length)),
        ...snapshot.parse(JSON.parse(String(row.value))),
      }));
  }
  set(
    botId: string,
    proposalId: string,
    before: z.infer<typeof MemorySchema> | null,
    after: z.infer<typeof MemorySchema> | null,
  ) {
    const value = snapshot.parse({ before, after, createdAt: new Date().toISOString() });
    this.db
      .prepare("INSERT INTO settings(key,value) VALUES (?,?)")
      .run(this.key(botId, proposalId), JSON.stringify(value));
    const pattern = `memory-undo:${botId}:%`;
    this.db
      .prepare(
        "DELETE FROM settings WHERE key LIKE ? AND key NOT IN (SELECT key FROM settings WHERE key LIKE ? ORDER BY json_extract(value,'$.createdAt') DESC,rowid DESC LIMIT 100)",
      )
      .run(pattern, pattern);
  }
  remove(botId: string, proposalId: string) {
    this.db.prepare("DELETE FROM settings WHERE key=?").run(this.key(botId, proposalId));
  }
  clearOwner(owner: MemoryOwner) {
    this.db
      .prepare(`DELETE FROM settings WHERE key LIKE 'memory-undo:%' AND (
      (json_extract(value,'$.before.scope')=? AND json_extract(value,'$.before.ownerId')=?) OR
      (json_extract(value,'$.after.scope')=? AND json_extract(value,'$.after.ownerId')=?))`)
      .run(owner.scope, owner.ownerId, owner.scope, owner.ownerId);
  }
  clear(botId: string) {
    this.db
      .prepare("DELETE FROM settings WHERE key LIKE ?")
      .run(`memory-undo:${IdSchema.parse(botId)}:%`);
  }
}
