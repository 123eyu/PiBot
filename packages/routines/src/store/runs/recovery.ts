import type { DatabaseSync } from "node:sqlite";
import { CanonicalTimeSchema } from "@pibot/protocol";
import { transaction } from "@pibot/storage";
import { completeOnceAppointments } from "./once-completion.ts";
export function recoverRoutineRuns(db: DatabaseSync, now = new Date().toISOString()) {
  CanonicalTimeSchema.parse(now);
  return transaction(db, () => {
    // Retain only certified parked checkpoints. Held gates and unknown side effects fail closed.
    // The certification is the kernel's data contract view (migration 0065), so recovery and the
    // kernel's parked-run queries cannot drift apart.
    const interrupted = `(status IN ('running','waiting') OR (status='scheduled' AND run_id IS NOT NULL)) AND id NOT IN (SELECT id FROM parked_unattended_runs)`;
    const affected = db
      .prepare(`SELECT COUNT(*) AS n FROM routine_runs WHERE ${interrupted}`)
      .get();
    db.prepare(
      `UPDATE approvals SET status='expired',remembered=0,resolved_at=? WHERE status='pending' AND routine_run_id IN (SELECT id FROM routine_runs WHERE ${interrupted})`,
    ).run(now);
    db.prepare(
      `UPDATE messages SET status='aborted',error_code='aborted' WHERE id IN (SELECT message_id FROM runs WHERE id IN (SELECT run_id FROM routine_runs WHERE ${interrupted}))`,
    ).run();
    db.prepare(
      `UPDATE runs SET status='aborted',stop_reason='restart',error_code='aborted',finished_at=? WHERE id IN (SELECT run_id FROM routine_runs WHERE ${interrupted})`,
    ).run(now);
    const orphans = db
      .prepare(
        "SELECT COUNT(*) AS n FROM runs WHERE kind='routine' AND status IN ('queued','running','waiting') AND NOT EXISTS(SELECT 1 FROM routine_runs r WHERE r.run_id=runs.id)",
      )
      .get();
    db.prepare(
      "UPDATE messages SET status='aborted',error_code='aborted' WHERE id IN (SELECT message_id FROM runs WHERE kind='routine' AND status IN ('queued','running','waiting') AND NOT EXISTS(SELECT 1 FROM routine_runs r WHERE r.run_id=runs.id))",
    ).run();
    db.prepare(
      "UPDATE runs SET status='aborted',stop_reason='restart',error_code='aborted',finished_at=? WHERE kind='routine' AND status IN ('queued','running','waiting') AND NOT EXISTS(SELECT 1 FROM routine_runs r WHERE r.run_id=runs.id)",
    ).run(now);
    db.prepare(
      "UPDATE tool_calls SET status='aborted',finished_at=? WHERE status IN ('pending','running') AND message_id IN (SELECT message_id FROM runs WHERE kind='routine' AND stop_reason='restart')",
    ).run(now);
    db.prepare(
      `UPDATE routine_runs SET status='failed',error_code='interrupted_restart',finished_at=?,active_ms=active_ms+CASE WHEN active_since IS NULL THEN 0 ELSE MAX(0,CAST((julianday(?)-julianday(active_since))*86400000 AS INTEGER)) END,waiting_ms=waiting_ms+CASE WHEN waiting_since IS NULL THEN 0 ELSE MAX(0,CAST((julianday(?)-julianday(waiting_since))*86400000 AS INTEGER)) END,active_since=NULL,waiting_since=NULL,wait_expires_at=NULL,owner_token=NULL WHERE ${interrupted}`,
    ).run(now, now, now);
    completeOnceAppointments(db, now);
    return Number(affected?.n ?? 0) + Number(orphans?.n ?? 0);
  });
}
