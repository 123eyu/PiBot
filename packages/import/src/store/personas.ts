// Replace only the explicitly reviewed persona and retain the exact prior value for undo.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RpcError } from "@pibot/protocol-base";
import { BotsRepo } from "@pibot/storage";
import { ImportFailure } from "./failure.ts";

export const personaHash = (text: string) => createHash("sha256").update(text).digest("hex");
export type PersonaSelection = { expected: string; text: string };

export class ImportPersonas {
  constructor(
    private readonly db: DatabaseSync,
    private readonly redact: (text: string) => string,
  ) {}

  current(botId: string) {
    const bot = new BotsRepo(this.db).get(botId);
    if (!bot || bot.archivedAt || bot.category !== "chat")
      throw new RpcError(-32602, "import_target");
    const text = bot.systemPrompt;
    if (text.length > 100_000 || this.redact(text) !== text)
      throw new RpcError(-32602, "import_persona_unavailable");
    return { text, hash: personaHash(text) };
  }

  apply(importId: string, botId: string, selection: PersonaSelection) {
    const current = this.current(botId);
    if (current.hash !== selection.expected || this.redact(selection.text) !== selection.text)
      throw new ImportFailure("memory_conflict");
    if (current.text === selection.text) return false;
    new BotsRepo(this.db).update(botId, { systemPrompt: selection.text });
    this.db
      .prepare("INSERT INTO import_personas(import_id,previous_prompt,applied_hash) VALUES(?,?,?)")
      .run(importId, current.text, personaHash(selection.text));
    return true;
  }

  undo(importId: string, botId: string) {
    const row = this.db
      .prepare("SELECT previous_prompt,applied_hash FROM import_personas WHERE import_id=?")
      .get(importId);
    if (!row) return false;
    const repo = new BotsRepo(this.db);
    const bot = repo.get(botId);
    if (bot && personaHash(bot.systemPrompt) !== row.applied_hash)
      throw new RpcError(-32011, "import_persona_conflict");
    if (bot) repo.update(botId, { systemPrompt: String(row.previous_prompt) });
    this.db.prepare("DELETE FROM import_personas WHERE import_id=?").run(importId);
    return !!bot;
  }
}
