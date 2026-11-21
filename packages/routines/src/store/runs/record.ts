import type { DatabaseSync } from "node:sqlite";
import { IdSchema, RoutineRunSchema } from "@pibot/protocol";
export const routineRunColumns = `id,routine_id AS routineId,bot_id AS botId,trigger_id AS triggerId,reason,scheduled_for AS scheduledFor,queued_at AS queuedAt,queue_expires_at AS queueExpiresAt,max_duration_min AS maxDurationMin,started_at AS startedAt,finished_at AS finishedAt,status,run_id AS runId,conversation_id AS conversationId,trigger_message_id AS triggerMessageId,error_code AS errorCode,summary,attention_reason AS attentionReason,resume_of AS resumeOf,occurrence_id AS occurrenceId,period_key AS periodKey,allowed_ops AS allowedOps,trial_draft AS trialDraft,dedupe_key AS dedupeKey,active_ms AS activeMs,waiting_ms AS waitingMs,active_since AS activeSince,waiting_since AS waitingSince,wait_expires_at AS waitExpiresAt,owner_token AS ownerToken,session_file AS sessionFile,attempt,wait_checkpoint AS waitCheckpoint,decision_consumed_at AS decisionConsumedAt,created_at AS createdAt`;
export function parseRoutineRun(row: Record<string, unknown>) {
  return RoutineRunSchema.parse({
    ...row,
    waitCheckpoint: row.waitCheckpoint == null ? null : JSON.parse(String(row.waitCheckpoint)),
    allowedOps: JSON.parse(String(row.allowedOps)),
    trialDraft: row.trialDraft == null ? null : JSON.parse(String(row.trialDraft)),
  });
}
export function getRoutineRun(db: DatabaseSync, id: string) {
  const row = db
    .prepare(`SELECT ${routineRunColumns} FROM routine_runs WHERE id=?`)
    .get(IdSchema.parse(id));
  return row ? parseRoutineRun(row) : undefined;
}
export function requireRoutineRun(db: DatabaseSync, id: string) {
  const r = getRoutineRun(db, id);
  if (!r) throw new TypeError("Missing persisted routine run");
  return r;
}
