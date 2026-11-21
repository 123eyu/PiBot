import type { DatabaseSync } from "node:sqlite";
import {
  AUTO_CHECK_DEFAULT_ROUNDS,
  AutoCheckCommandSchema,
  type AutoCheckSettings,
  AutoCheckSettingsSchema,
  IdSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

const StoredCommandsSchema = z.array(AutoCheckCommandSchema).max(3);

/** A Bot's automatic check switch (`bot_auto_check`); NULL columns are "unset". */
export class BotAutoCheckRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Undefined for an unknown Bot. */
  get(botId: string): AutoCheckSettings | undefined {
    const id = IdSchema.parse(botId);
    if (!this.db.prepare("SELECT 1 FROM bots WHERE id = ?").get(id)) return undefined;
    const row = this.db
      .prepare("SELECT enabled, rounds FROM bot_auto_check WHERE bot_id = ?")
      .get(id);
    return AutoCheckSettingsSchema.parse({
      botId: id,
      enabled: row?.enabled === 1,
      rounds: row?.rounds == null ? AUTO_CHECK_DEFAULT_ROUNDS : Number(row.rounds),
      stored: row?.enabled != null,
    });
  }

  set(botId: string, change: { enabled?: boolean; rounds?: number }) {
    const id = IdSchema.parse(botId);
    this.db
      .prepare(
        `INSERT INTO bot_auto_check (bot_id, enabled, rounds, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET
           enabled = COALESCE(excluded.enabled, enabled),
           rounds = COALESCE(excluded.rounds, rounds),
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        change.enabled === undefined ? null : change.enabled ? 1 : 0,
        change.rounds ?? null,
        new Date().toISOString(),
      );
    return this.get(id);
  }

  /** A role's default: written only while the switch is unset, never over the user's choice. */
  setDefault(botId: string, enabled: boolean): boolean {
    const id = IdSchema.parse(botId);
    const result = this.db
      .prepare(
        `INSERT INTO bot_auto_check (bot_id, enabled, rounds, updated_at) VALUES (?, ?, NULL, ?)
         ON CONFLICT(bot_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
         WHERE bot_auto_check.enabled IS NULL`,
      )
      .run(id, enabled ? 1 : 0, new Date().toISOString());
    return Number(result.changes) > 0;
  }
}

/**
 * Confirmed check commands per folder (`folder_checks`), keyed by the primary folder's
 * real path (case-folded on Windows by the caller). `[]` means "don't check this folder".
 */
export class FolderChecksRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Null when the folder has no row (the Bot is asked to propose commands). */
  get(folderKey: string): string[] | null {
    const row = this.db
      .prepare("SELECT commands FROM folder_checks WHERE folder_key = ?")
      .get(z.string().min(1).parse(folderKey));
    if (!row) return null;
    const parsed = StoredCommandsSchema.safeParse(JSON.parse(String(row.commands)));
    // A damaged row is treated as unknown: the Bot proposes again rather than running garbage.
    return parsed.success ? parsed.data : null;
  }

  set(folderKey: string, path: string, commands: readonly string[]) {
    this.db
      .prepare(
        `INSERT INTO folder_checks (folder_key, path, commands, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(folder_key) DO UPDATE SET path = excluded.path, commands = excluded.commands,
           updated_at = excluded.updated_at`,
      )
      .run(
        z.string().min(1).parse(folderKey),
        z.string().min(1).parse(path),
        JSON.stringify(StoredCommandsSchema.parse(commands)),
        new Date().toISOString(),
      );
  }

  forget(folderKey: string) {
    this.db.prepare("DELETE FROM folder_checks WHERE folder_key = ?").run(folderKey);
  }
}
