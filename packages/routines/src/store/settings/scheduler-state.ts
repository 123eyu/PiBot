import type { DatabaseSync } from "node:sqlite";
import { CanonicalTimeSchema, IdSchema } from "@pibot/protocol";
import { transaction } from "@pibot/storage";
import { requireRoutineRun } from "../runs/record.ts";

/** Scheduler metadata only; this adapter cannot claim an execution or change its state. */
export class RoutineSchedulerStateRepo {
  constructor(private readonly db: DatabaseSync) {}
  lastCompleted(routineId: string) {
    const row = this.db
      .prepare(
        "SELECT id FROM routine_runs WHERE routine_id=? AND status='done' AND summary IS NOT NULL ORDER BY finished_at DESC,id DESC LIMIT 1",
      )
      .get(IdSchema.parse(routineId));
    return row ? requireRoutineRun(this.db, String(row.id)) : undefined;
  }
  markMissedTooOld(id: string) {
    IdSchema.parse(id);
    return transaction(this.db, () => {
      const run = requireRoutineRun(this.db, id);
      if (run.status !== "skipped_missed") throw new TypeError("Expected skipped missed run");
      if (run.errorCode && run.errorCode !== "missed_too_old")
        throw new TypeError("Missed notice already has another reason");
      this.db
        .prepare(
          "UPDATE routine_runs SET error_code='missed_too_old' WHERE id=? AND status='skipped_missed'",
        )
        .run(id);
      return requireRoutineRun(this.db, id);
    });
  }
}

/** Explicit trusted development injection is necessary because production activity only advances. */
export class RoutineDevStateRepo {
  constructor(
    private readonly db: DatabaseSync,
    options: { dev: true },
  ) {
    if (options.dev !== true) throw new TypeError("Development state requires trusted injection");
  }
  setUiActive(at: string) {
    CanonicalTimeSchema.parse(at);
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES ('ui.lastActiveAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(at));
  }
}
