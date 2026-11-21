import type { DatabaseSync } from "node:sqlite";
import {
  CanonicalTimeSchema,
  IdSchema,
  RoutineTriggerInputSchema,
  RoutineTriggerStateSchema,
} from "@pibot/protocol";

/** What routines contribute to brain standby: their triggers and runs still due. Metadata only. */
export class RoutineWakeRepo {
  constructor(private readonly db: DatabaseSync) {}
  /** A routine run that is scheduled or under way keeps the brain awake. */
  hasDueRuns() {
    return !!this.db
      .prepare(
        "SELECT 1 FROM routine_runs WHERE status IN ('scheduled','running','waiting') LIMIT 1",
      )
      .get();
  }
  triggers(before = "") {
    return this.db
      .prepare(`SELECT t.id,t.routine_id,t.config,t.created_at,r.last_scheduled_at,
      json_extract(t.state,'$.consumedAt') AS consumed_at,
      json_extract(t.state,'$.lastScheduledAt') AS trigger_at,
      json_extract(t.state,'$.lastTriggeredAt') AS triggered_at,
      json_extract(t.state,'$.pendingCount') AS pending_count,
      json_extract(t.state,'$.snapshot.complete') AS baseline_complete,
      COALESCE(json_extract(t.state,'$.connection.checkedAt'),
        json_extract(t.state,'$.calendar.checkedAt')) AS app_checked_at,
      json_extract(t.state,'$.calendar.nextDueAt') AS app_next_due_at
      FROM routine_triggers t JOIN routines r ON r.id=t.routine_id JOIN bots b ON b.id=r.bot_id
      WHERE t.id>? AND t.deleted_at IS NULL AND r.deleted_at IS NULL AND r.enabled=1
      AND r.paused_reason IS NULL AND b.archived_at IS NULL ORDER BY t.id LIMIT 200`)
      .all(before)
      .map((row) => ({
        id: IdSchema.parse(row.id),
        routineId: IdSchema.parse(row.routine_id),
        baselineComplete: row.baseline_complete === 1,
        config: RoutineTriggerInputSchema.parse(JSON.parse(String(row.config))),
        state: RoutineTriggerStateSchema.parse({
          consumedAt: row.consumed_at ?? null,
          lastScheduledAt: row.trigger_at ?? null,
          lastTriggeredAt: row.triggered_at ?? null,
          pendingCount: row.pending_count ?? 0,
        }),
        createdAt: CanonicalTimeSchema.parse(row.created_at),
        /** When a connection or calendar trigger last looked, and its next due event. */
        appCheck: {
          checkedAt:
            row.app_checked_at == null ? null : CanonicalTimeSchema.parse(row.app_checked_at),
          nextDueAt:
            row.app_next_due_at == null ? null : CanonicalTimeSchema.parse(row.app_next_due_at),
        },
        lastScheduledAt:
          row.last_scheduled_at == null ? null : CanonicalTimeSchema.parse(row.last_scheduled_at),
      }));
  }
}
