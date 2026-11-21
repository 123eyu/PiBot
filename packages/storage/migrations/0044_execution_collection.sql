ALTER TABLE task_instances ADD COLUMN archived_at TEXT;
ALTER TABLE task_instances ADD COLUMN deleted_at TEXT;
ALTER TABLE task_instances ADD COLUMN archive_batch_id TEXT;
CREATE INDEX task_visibility_page ON task_instances
  (bot_id,source_conversation_id,deleted_at,archived_at,created_at DESC,id DESC);
CREATE TABLE execution_plan_archive (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  archived_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX plan_archive_page ON execution_plan_archive
  (bot_id,conversation_id,deleted_at,archived_at DESC,id DESC);
