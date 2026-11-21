import type { DatabaseSync } from "node:sqlite";
import { type BackgroundPreferences, BackgroundPreferencesSchema } from "@pibot/protocol-base";

// The shared settings table already supports independent namespaces; no schema migration.
export class BackgroundPreferencesRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(): BackgroundPreferences {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("independentBackground");
    return BackgroundPreferencesSchema.parse(row ? JSON.parse(String(row.value)) : {});
  }
  set(value: BackgroundPreferences): BackgroundPreferences {
    const parsed = BackgroundPreferencesSchema.parse(value);
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run("independentBackground", JSON.stringify(parsed));
    return parsed;
  }
}
