ALTER TABLE group_execution_limits ADD COLUMN mode TEXT NOT NULL DEFAULT 'execute'
  CHECK(mode IN ('execute','plan'));

-- Preserve an existing current-topic read-only ceiling when replacing per-member controls.
INSERT INTO group_execution_limits(group_id,limits_json,version,updated_at,mode)
SELECT g.id,
  '{"activeSeconds":7200,"toolCalls":1000,"modelRequests":256,"childTasks":32,"childConcurrency":4,"childDepth":3,"tokens":10000000,"costUsd":null}',
  1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'plan'
FROM groups g JOIN group_current_topics current ON current.group_id=g.id WHERE EXISTS (
  SELECT 1 FROM execution_settings e JOIN conversations c ON c.id=e.conversation_id
  JOIN group_members m ON m.group_id=g.id AND m.bot_id=e.bot_id
  WHERE c.group_id=g.id AND c.archived_at IS NULL AND e.mode='plan'
    AND (c.id=current.conversation_id OR (c.kind='thread' AND c.thread_of=current.conversation_id))
)
ON CONFLICT(group_id) DO UPDATE SET mode='plan',version=group_execution_limits.version+1,
  updated_at=excluded.updated_at;
