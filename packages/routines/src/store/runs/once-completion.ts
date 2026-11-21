import type { DatabaseSync } from "node:sqlite";

// Call inside the terminal transition transaction, including skip enqueue and restart recovery.
// The current trigger identity, rather than the routine ID alone, fences edits made during a run.
export function completeOnceAppointments(db: DatabaseSync, now: string, runId?: string) {
  return Number(
    db
      .prepare(
        `UPDATE routines SET enabled=0,updated_at=?,version=version+1
         WHERE enabled=1 AND deleted_at IS NULL AND EXISTS (
           SELECT 1 FROM routine_runs r JOIN routine_triggers t ON t.id=r.trigger_id
           WHERE r.routine_id=routines.id AND r.bot_id=routines.bot_id
             AND t.routine_id=routines.id AND t.deleted_at IS NULL AND t.kind='once'
             AND json_extract(t.state,'$.consumedAt') IS NOT NULL
             AND r.reason IN ('once','catchup') AND r.dedupe_key='once:'||t.id
             AND r.scheduled_for=json_extract(t.config,'$.at')
             AND r.status IN ('done','failed','cancelled','timeout','skipped_overlap','skipped_missed')
             AND (? IS NULL OR r.id=?)
         )`,
      )
      .run(now, runId ?? null, runId ?? null).changes,
  );
}
