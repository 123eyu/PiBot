import type { DatabaseSync } from "node:sqlite";

// The aliases belong to this module and question-inbox.ts; no caller input becomes SQL.
// A topic association is not authority. Only a user turn, or the program's bounded chain
// of background completions from that turn, can supply an answerable ordinary-chat card.
export const routineQuestionOriginSql = `c.kind='dm' AND c.bot_id=r.bot_id
AND c.internal_task_id IS NULL AND c.archived_at IS NULL
AND r.kind='chat' AND r.status='done'
AND r.group_id IS NULL AND r.task_id IS NULL AND r.cycle_id IS NULL
AND EXISTS (
  WITH RECURSIVE origin(id,depth) AS (
    SELECT r.id,0
    UNION ALL
    SELECT parent.id,origin.depth+1 FROM origin
    JOIN runs child ON child.id=origin.id
    JOIN runs parent ON parent.id=child.parent_run_id
    JOIN messages event ON event.id=child.user_message_id
    JOIN messages previous ON previous.id=parent.message_id
    WHERE origin.depth<12 AND child.automatic=1
    AND child.kind='chat' AND child.status='done'
    AND child.bot_id=r.bot_id AND child.conversation_id=c.id
    AND child.group_id IS NULL AND child.task_id IS NULL AND child.cycle_id IS NULL
    AND parent.kind='chat' AND parent.status='done'
    AND parent.bot_id=r.bot_id AND parent.conversation_id=c.id
    AND parent.group_id IS NULL AND parent.task_id IS NULL AND parent.cycle_id IS NULL
    AND previous.role='assistant' AND previous.status='done'
    AND previous.bot_id=r.bot_id AND previous.conversation_id=c.id
    AND previous.run_id=parent.id AND previous.rowid<event.rowid
    AND event.role='user' AND event.status='done' AND event.bot_id IS NULL
    AND event.conversation_id=c.id AND event.run_id IS NULL
    AND json_extract(event.usage,'$.systemEvent')=1
    AND event.routine_trigger IS NULL
    AND json_extract(event.usage,'$.trigger')='background_finished'
    AND json_extract(event.usage,'$.backgroundBotId')=r.bot_id
    AND json_type(event.usage,'$.backgroundCommandIds')='array'
    AND json_array_length(event.usage,'$.backgroundCommandIds') BETWEEN 1 AND 32
    AND (child.trigger_key='background_finished:'||json_extract(event.usage,'$.backgroundCommandId')
      OR (json_array_length(event.usage,'$.backgroundCommandIds')>1
        AND child.trigger_key GLOB 'background_finished:batch:*'))
    AND EXISTS (SELECT 1 FROM background_completion_runs binding
      WHERE binding.run_id=child.id
      AND binding.job_id=json_extract(event.usage,'$.backgroundCommandId'))
    AND (SELECT COUNT(*) FROM (SELECT 1 FROM background_completion_runs binding
      WHERE binding.run_id=child.id LIMIT 33))=json_array_length(event.usage,'$.backgroundCommandIds')
    AND NOT EXISTS (SELECT 1 FROM background_completion_runs binding
      LEFT JOIN background_commands job ON job.id=binding.job_id
      WHERE binding.run_id=child.id AND (
        job.id IS NULL OR job.run_id<>parent.id OR job.bot_id<>r.bot_id
        OR job.conversation_id IS NOT c.id OR job.group_id IS NOT NULL
        OR job.ended_at IS NULL OR job.status='running'
        OR (job.status='stopped' AND job.stop_reason IS NOT 'time_limit')
        OR NOT EXISTS (SELECT 1 FROM json_each(event.usage,'$.backgroundCommandIds') item
          WHERE item.type='text' AND item.value=binding.job_id)))
    AND NOT EXISTS (SELECT 1 FROM json_each(event.usage,'$.backgroundCommandIds') item
      WHERE item.type<>'text' OR NOT EXISTS (SELECT 1 FROM background_completion_runs binding
        WHERE binding.run_id=child.id AND binding.job_id=item.value))
  )
  SELECT 1 FROM origin JOIN runs root ON root.id=origin.id
  JOIN messages input ON input.id=root.user_message_id
  JOIN messages output ON output.id=root.message_id
  WHERE root.kind='chat' AND root.status='done' AND root.automatic=0
  AND root.bot_id=r.bot_id AND root.conversation_id=c.id
  AND root.group_id IS NULL AND root.task_id IS NULL AND root.cycle_id IS NULL
  AND input.role='user' AND input.status='done' AND input.bot_id IS NULL
  AND input.conversation_id=c.id AND input.run_id=root.id
  AND COALESCE(json_extract(input.usage,'$.systemEvent'),0)=0
  AND input.routine_trigger IS NULL
  AND output.role='assistant' AND output.status='done'
  AND output.bot_id=r.bot_id AND output.conversation_id=c.id
  AND output.run_id=root.id AND input.rowid<output.rowid
  AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.conversation_id=c.id
    AND newer.role='user' AND newer.rowid>input.rowid
    AND newer.rowid<(SELECT rowid FROM messages current WHERE current.id=r.message_id)
    AND COALESCE(json_extract(newer.usage,'$.systemEvent'),0)=0)
)`;

/** This is provenance only; answering still uses the ordinary send transaction and policy. */
export function hasRoutineQuestionUserOrigin(db: DatabaseSync, runId: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM runs r JOIN conversations c ON c.id=r.conversation_id
      WHERE r.id=? AND (${routineQuestionOriginSql})`)
    .get(runId);
}
