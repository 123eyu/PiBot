import type { DatabaseSync } from "node:sqlite";
import {
  CanonicalTimeSchema,
  type RoutineSettings,
  RoutineSettingsPatchSchema,
  RoutineSettingsSchema,
} from "@pibot/protocol";
import { transaction } from "@pibot/storage";
export class RoutineSettingsRepo {
  constructor(private readonly db: DatabaseSync) {}
  private read(key: string) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  private write(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  get(): RoutineSettings {
    return RoutineSettingsSchema.parse({
      missedPolicy: this.read("routines.missedPolicy"),
      keepAwake: this.read("routines.keepAwake"),
      pauseWhenAway: this.read("routines.pauseWhenAway"),
    });
  }
  set(patch: Partial<RoutineSettings>) {
    const p = RoutineSettingsPatchSchema.parse(patch);
    return transaction(this.db, () => {
      for (const [k, v] of Object.entries(p)) if (v !== undefined) this.write(`routines.${k}`, v);
      return this.get();
    });
  }
  pausedUntil(): string | null {
    const value = this.read("routines.pausedUntil");
    return value == null ? null : CanonicalTimeSchema.parse(value);
  }
  pauseAll(until: string) {
    CanonicalTimeSchema.parse(until);
    if (Date.parse(until) <= Date.now()) throw new TypeError("Pause deadline must be in future");
    this.write("routines.pausedUntil", until);
  }
  resumeAll() {
    this.write("routines.pausedUntil", null);
  }
  lastUiActiveAt(): string | null {
    const value = this.read("ui.lastActiveAt");
    return value == null ? null : CanonicalTimeSchema.parse(value);
  }
  uiActive(at: string) {
    CanonicalTimeSchema.parse(at);
    return transaction(this.db, () => {
      const old = this.lastUiActiveAt();
      if (!old || Date.parse(at) > Date.parse(old)) this.write("ui.lastActiveAt", at);
      return this.lastUiActiveAt();
    });
  }
}
