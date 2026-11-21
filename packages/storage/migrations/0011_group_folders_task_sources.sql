CREATE TABLE IF NOT EXISTS group_folders (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(group_id,path)
);
CREATE INDEX IF NOT EXISTS group_folders_order ON group_folders(group_id,position,id);
CREATE TABLE IF NOT EXISTS group_task_sources (
  task_id TEXT PRIMARY KEY REFERENCES group_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('user','coordinator','unknown')),
  message_id TEXT,
  conversation_id TEXT,
  batch_message_id TEXT
);
CREATE INDEX IF NOT EXISTS group_task_sources_batch ON group_task_sources(batch_message_id,task_id);
CREATE INDEX IF NOT EXISTS group_task_sources_kind ON group_task_sources(kind,task_id);
CREATE INDEX IF NOT EXISTS group_tasks_section ON group_tasks(group_id,status,created_at,id);
CREATE INDEX IF NOT EXISTS runs_task_activity ON runs(task_id,created_at,id);
CREATE INDEX IF NOT EXISTS runs_parent_activity ON runs(parent_run_id,status);
-- Reminder origins are mutable. Only a retained original child/parent run proves creation provenance.
INSERT OR IGNORE INTO group_task_sources(task_id,kind,message_id,conversation_id,batch_message_id)
SELECT t.id,
  CASE WHEN p.kind='chat' AND p.user_message_id IS NOT NULL AND (m.id IS NULL OR m.role='user') THEN 'user'
       WHEN p.id IS NOT NULL THEN 'coordinator' ELSE 'unknown' END,
  CASE WHEN p.kind='chat' AND p.user_message_id IS NOT NULL AND (m.id IS NULL OR m.role='user') THEN p.user_message_id ELSE p.message_id END,
  p.conversation_id,p.message_id
FROM group_tasks t
LEFT JOIN runs child ON child.id=(SELECT r.id FROM runs r WHERE r.task_id=t.id
  AND r.kind='group_task' AND r.parent_run_id IS NOT NULL ORDER BY r.created_at,r.id LIMIT 1)
LEFT JOIN runs p ON p.id=child.parent_run_id AND p.group_id=t.group_id
  AND p.bot_id=t.created_by_bot_id AND EXISTS(SELECT 1 FROM conversations c
    WHERE c.id=p.conversation_id AND c.kind='group' AND c.group_id=t.group_id)
LEFT JOIN messages m ON m.id=p.user_message_id AND m.conversation_id=p.conversation_id;
