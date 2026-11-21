import type { DatabaseSync } from "node:sqlite";
import {
  IdSchema,
  RoutineActiveViewSchema,
  RoutineOnceOutcomeSchema,
  RoutineResultViewSchema,
} from "@pibot/protocol";
import { requireRoutineRun } from "../runs/record.ts";

export class RoutineDisplayRepo {
  constructor(private readonly db: DatabaseSync) {}
  state(routineId: string) {
    IdSchema.parse(routineId);
    const active = this.db
      .prepare(
        "SELECT id FROM routine_runs WHERE routine_id=? AND status IN ('scheduled','running','waiting') LIMIT 1",
      )
      .get(routineId);
    // Skipped triggers are history; neither overlap nor missed notices replace an actual result.
    const last = this.db
      .prepare(
        "SELECT id FROM routine_runs WHERE routine_id=? AND status IN ('done','failed','cancelled','timeout') ORDER BY finished_at DESC,id DESC LIMIT 1",
      )
      .get(routineId);
    const once = this.db
      .prepare(
        "SELECT r.id FROM routine_runs r WHERE r.trigger_id=(SELECT t.id FROM routine_triggers t WHERE t.routine_id=? AND t.kind='once' AND t.deleted_at IS NULL AND json_extract(t.state,'$.consumedAt') IS NOT NULL LIMIT 1) ORDER BY r.created_at DESC,r.id DESC LIMIT 1",
      )
      .get(routineId);
    const attention = this.db
      .prepare(`SELECT
      (SELECT COUNT(*) FROM approvals a JOIN routine_runs rr ON rr.id=a.routine_run_id WHERE rr.routine_id=? AND a.status='pending') +
      (SELECT COUNT(*) FROM routine_runs WHERE routine_id=? AND (status='missed' OR (status='skipped_missed' AND error_code='missed_too_old' AND inbox_dismissed_at IS NULL))) +
      (SELECT COUNT(*) FROM routine_proposals WHERE status='open' AND json_extract(payload,'$.routineId')=?) +
      (SELECT COUNT(*) FROM routines WHERE id=? AND deleted_at IS NULL AND paused_reason IN ('trigger_error','away_7d')) AS n`)
      .get(routineId, routineId, routineId, routineId);
    return {
      onceOutcome: once
        ? RoutineOnceOutcomeSchema.strip().parse(requireRoutineRun(this.db, String(once.id)))
        : null,
      active: active
        ? RoutineActiveViewSchema.strip().parse(requireRoutineRun(this.db, String(active.id)))
        : null,
      lastResult: last
        ? RoutineResultViewSchema.strip().parse(requireRoutineRun(this.db, String(last.id)))
        : null,
      attentionCount: Number(attention?.n ?? 0),
    };
  }
}
