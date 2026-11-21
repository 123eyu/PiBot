import type { DatabaseSync } from "node:sqlite";

/** Preserve every execution record; only a completely empty cancelled group wake is silent. */
export function markEmptyCancelledWake(db: DatabaseSync, runId: string) {
  return Number(
    db
      .prepare(`UPDATE messages SET usage=json_set(COALESCE(usage,'{}'),'$.silentWake',json('true'))
    WHERE run_id=? AND role='assistant' AND status='aborted'
    AND EXISTS(SELECT 1 FROM runs r WHERE r.id=? AND r.kind='wake' AND r.group_id IS NOT NULL
      AND r.status='aborted' AND r.stop_reason='aborted')
    AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.run_id=? AND (
      trim(m.content)<>'' OR m.role<>'assistant'
      OR EXISTS(SELECT 1 FROM tool_calls t WHERE t.message_id=m.id)
      OR EXISTS(SELECT 1 FROM attachments a WHERE a.message_id=m.id)
      OR EXISTS(SELECT 1 FROM message_attachment_links a WHERE a.message_id=m.id)))`)
      .run(runId, runId, runId).changes,
  );
}
