import type { DatabaseSync } from "node:sqlite";
import { type BotHooksConfig, BotHooksConfigSchema, IdSchema } from "@pibot/protocol-base";

/** Bot-local settings stay separate from app defaults and portable team templates. */
export class BotHooksRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(botId: string): BotHooksConfig | undefined {
    const id = IdSchema.parse(botId);
    if (!this.db.prepare("SELECT 1 FROM bots WHERE id=? AND archived_at IS NULL").get(id))
      return undefined;
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(`bot-hooks:${id}`);
    return BotHooksConfigSchema.parse(
      row
        ? JSON.parse(String(row.value))
        : {
            formatOnWrite: false,
            formatCommand: "",
            notifyOnCompletion: false,
          },
    );
  }
  set(botId: string, value: BotHooksConfig): BotHooksConfig | undefined {
    const id = IdSchema.parse(botId);
    if (!this.get(id)) return undefined;
    const config = BotHooksConfigSchema.parse(value);
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`bot-hooks:${id}`, JSON.stringify(config));
    return config;
  }
}
