import type { DatabaseSync } from "node:sqlite";
import { type RoutineTiming, RoutineTimingDefaults, RoutineTimingSchema } from "@pibot/protocol";
import { transaction } from "@pibot/storage";
import { completeOnceAppointments } from "./once-completion.ts";
import { getRoutineRun, requireRoutineRun } from "./record.ts";
export class RoutineRunMissedRepo {
  constructor(private readonly db: DatabaseSync) {}
  resolve(
    id: string,
    action: "catchup" | "skip",
    timing: Pick<Partial<RoutineTiming>, "queueWaitMs" | "missedMaxAgeMs"> = {},
  ) {
    const queueWaitMs = timing.queueWaitMs ?? RoutineTimingDefaults.queueWaitMs,
      missedMaxAgeMs = timing.missedMaxAgeMs ?? RoutineTimingDefaults.missedMaxAgeMs;
    RoutineTimingSchema.shape.queueWaitMs.parse(queueWaitMs);
    RoutineTimingSchema.shape.missedMaxAgeMs.parse(missedMaxAgeMs);
    if (!["catchup", "skip"].includes(action)) throw new TypeError("Invalid missed action");
    return transaction(this.db, () => {
      const r = getRoutineRun(this.db, id);
      if (r?.status === "skipped_missed" && r.errorCode === "missed_too_old" && action === "skip") {
        this.db
          .prepare(
            "UPDATE routine_runs SET inbox_dismissed_at=? WHERE id=? AND inbox_dismissed_at IS NULL",
          )
          .run(new Date().toISOString(), id);
        return r;
      }
      if (r?.status !== "missed") return undefined;
      if (action === "catchup" && Date.now() - Date.parse(r.scheduledFor) > missedMaxAgeMs)
        throw new TypeError("Missed run too old");
      // The active partial index also protects a user click racing a cron trigger.
      const status =
        action === "skip"
          ? "skipped_missed"
          : this.db
                .prepare(
                  "SELECT 1 FROM routine_runs WHERE routine_id=? AND status IN ('scheduled','running','waiting')",
                )
                .get(r.routineId ?? null)
            ? "skipped_overlap"
            : "scheduled";
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE routine_runs SET status=?,finished_at=?,reason=CASE WHEN ?='scheduled' THEN 'catchup' ELSE reason END,queued_at=?,queue_expires_at=? WHERE id=? AND status='missed'",
        )
        .run(
          status,
          status === "scheduled" ? null : now,
          status,
          status === "scheduled" ? new Date().toISOString() : null,
          status === "scheduled" ? new Date(Date.now() + queueWaitMs).toISOString() : null,
          id,
        );
      if (status !== "scheduled") completeOnceAppointments(this.db, now, id);
      return requireRoutineRun(this.db, id);
    });
  }
}
