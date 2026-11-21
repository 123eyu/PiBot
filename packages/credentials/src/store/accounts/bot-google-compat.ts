import type { DatabaseSync } from "node:sqlite";
import {
  type BotGoogleCompat,
  BotGoogleCompatSchema,
  IdSchema,
} from "@pibot/credentials-contract/full";

/**
 * The Google compatibility switch of one Bot's browser (`bots.google_compat_at`). On by
 * default (new Bots get it at creation, migration 0035 turned it on for existing ones);
 * the user turns it off or on again from the Bot's profile panel or the refused-sign-in banner.
 */
export class BotGoogleCompatRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Undefined for an unknown Bot. */
  get(botId: string): BotGoogleCompat | undefined {
    const row = this.db
      .prepare("SELECT id, google_compat_at FROM bots WHERE id = ?")
      .get(IdSchema.parse(botId));
    if (!row) return undefined;
    const enabledAt = row.google_compat_at == null ? null : String(row.google_compat_at);
    return BotGoogleCompatSchema.parse({ botId: row.id, enabled: enabledAt !== null, enabledAt });
  }

  enabled(botId: string): boolean {
    return this.get(botId)?.enabled ?? false;
  }

  /** Metadata only: does not touch updated_at, so the Bot list order stays. */
  set(botId: string, enabled: boolean): BotGoogleCompat | undefined {
    this.db
      .prepare(
        "UPDATE bots SET google_compat_at = CASE WHEN ? THEN COALESCE(google_compat_at, ?) ELSE NULL END WHERE id = ?",
      )
      .run(enabled ? 1 : 0, new Date().toISOString(), IdSchema.parse(botId));
    return this.get(botId);
  }
}
