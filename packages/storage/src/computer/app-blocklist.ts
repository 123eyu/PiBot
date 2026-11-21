import type { DatabaseSync } from "node:sqlite";
import {
  BOT_BROWSER_APP_ID,
  type ComputerApp,
  ComputerAppIdSchema,
  ComputerAppSchema,
  type ComputerBlocklistEntry,
  ComputerBlocklistEntrySchema,
  type ComputerSettings,
  ComputerSettingsSchema,
  sameAppId,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";

const columns = "app_id AS appId,name,source,removable";
function parse(row: Record<string, unknown>): ComputerBlocklistEntry {
  return ComputerBlocklistEntrySchema.parse({ ...row, removable: row.removable === 1 });
}
/** The whole list is a few hundred rows at most, so callers get it in one bounded read. */
const MAX_ENTRIES = 500;

export class AppBlocklistRepo {
  constructor(private readonly db: DatabaseSync) {}

  list(): ComputerBlocklistEntry[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM app_blocklist WHERE removed_at IS NULL ORDER BY removable,name,app_id LIMIT ?`,
      )
      .all(MAX_ENTRIES)
      .map(parse);
  }

  /**
   * Active rows plus removable defaults the user unticked (`removed: true`), so
   * settings can show unticked suggestions. User-added rows that were removed are left out.
   */
  listWithRemoved(): ComputerBlocklistEntry[] {
    return this.db
      .prepare(
        `SELECT ${columns},removed_at IS NOT NULL AS removed FROM app_blocklist
          WHERE removed_at IS NULL OR source='default' ORDER BY removable,name,app_id LIMIT ?`,
      )
      .all(MAX_ENTRIES)
      .map(({ removed, ...row }) => ({ ...parse(row), removed: removed === 1 }));
  }

  /** Returns the subset of `appIds` that are blocked; matching is case-insensitive. */
  blockedAmong(appIds: readonly string[]): Set<string> {
    const ids = appIds.map((id) => ComputerAppIdSchema.parse(id));
    if (!ids.length) return new Set();
    if (ids.length > MAX_ENTRIES) throw new TypeError("Too many apps");
    const rows = this.db
      .prepare(
        `SELECT app_id AS appId FROM app_blocklist WHERE removed_at IS NULL AND app_id IN (${ids
          .map(() => "?")
          .join(",")})`,
      )
      .all(...ids);
    const hits = new Set(rows.map((row) => String(row.appId).toLowerCase()));
    return new Set(ids.filter((id) => hits.has(id.toLowerCase())));
  }

  isBlocked(appId: string): boolean {
    return this.blockedAmong([appId]).size > 0;
  }

  add(app: ComputerApp): ComputerBlocklistEntry {
    const value = ComputerAppSchema.parse(app);
    // The Bot's own browser is not a desktop app; blocking it belongs to the web category.
    if (sameAppId(value.id, BOT_BROWSER_APP_ID)) throw new TypeError("Cannot block Bot browser");
    return transaction(this.db, () => {
      this.db
        .prepare(`INSERT INTO app_blocklist(app_id,name,source,removable,created_at)
          VALUES (?,?,'user',1,?) ON CONFLICT(app_id) DO UPDATE SET removed_at=NULL`)
        .run(value.id, value.name, new Date().toISOString());
      return parse(
        this.db.prepare(`SELECT ${columns} FROM app_blocklist WHERE app_id=?`).get(value.id) ?? {},
      );
    });
  }

  /** Only removable entries can be lifted; non-removable defaults stay blocked. */
  remove(appId: string): boolean {
    const id = ComputerAppIdSchema.parse(appId);
    return (
      this.db
        .prepare(
          "UPDATE app_blocklist SET removed_at=? WHERE app_id=? AND removable=1 AND removed_at IS NULL",
        )
        .run(new Date().toISOString(), id).changes > 0
    );
  }
}

const RETENTION_KEY = "computer.screenshotRetentionDays";
export class ComputerSettingsRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(): ComputerSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(RETENTION_KEY);
    return ComputerSettingsSchema.parse({
      screenshotRetentionDays: row ? JSON.parse(String(row.value)) : 7,
    });
  }

  set(settings: ComputerSettings): ComputerSettings {
    const value = ComputerSettingsSchema.parse(settings);
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(RETENTION_KEY, JSON.stringify(value.screenshotRetentionDays));
    return value;
  }
}
