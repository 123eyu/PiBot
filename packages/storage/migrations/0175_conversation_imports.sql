-- Publish a completed batch atomically while allowing short transactions for individual pages.
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  -- Like the audit log, keep the batch receipt after a Bot is deleted.
  bot_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','completed','cancelled','failed','undone')),
  topics INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  reason TEXT
);
ALTER TABLE conversations ADD COLUMN import_id TEXT REFERENCES import_jobs(id);
ALTER TABLE conversations ADD COLUMN import_source TEXT;
ALTER TABLE messages ADD COLUMN import_id TEXT REFERENCES import_jobs(id);
CREATE INDEX conversations_import_id ON conversations(import_id) WHERE import_id IS NOT NULL;
CREATE INDEX messages_import_id ON messages(import_id) WHERE import_id IS NOT NULL;

-- Ordinary chat writers must not attach live data to imported history, even through a new caller.
CREATE TRIGGER import_topic_owner BEFORE INSERT ON conversations
WHEN (NEW.import_id IS NULL AND NEW.import_source IS NOT NULL)
  OR (NEW.import_id IS NOT NULL AND (
    NEW.kind<>'dm' OR NEW.pi_session_file IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM import_jobs WHERE id=NEW.import_id AND state='running'
        AND source=NEW.import_source AND bot_id=NEW.bot_id
    )
  ))
BEGIN
  SELECT RAISE(ABORT, 'import_topic_read_only');
END;
CREATE TRIGGER import_message_owner BEFORE INSERT ON messages
WHEN NEW.import_id IS NOT (SELECT import_id FROM conversations WHERE id=NEW.conversation_id)
  OR (NEW.import_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM import_jobs WHERE id=NEW.import_id AND state='running'
  ))
BEGIN
  SELECT RAISE(ABORT, 'import_topic_read_only');
END;
CREATE TRIGGER import_message_read_only BEFORE UPDATE ON messages
WHEN OLD.import_id IS NOT NULL OR NEW.import_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'import_topic_read_only');
END;
-- Title, archive state, and activity time remain ordinary topic metadata.
CREATE TRIGGER import_topic_read_only BEFORE UPDATE ON conversations
WHEN (OLD.import_id IS NOT NULL OR NEW.import_id IS NOT NULL) AND NOT (
  OLD.id IS NEW.id
  AND OLD.bot_id IS NEW.bot_id
  AND OLD.kind IS NEW.kind
  AND OLD.group_id IS NEW.group_id
  AND OLD.thread_of IS NEW.thread_of
  AND OLD.import_id IS NEW.import_id
  AND OLD.import_source IS NEW.import_source
  AND OLD.pi_session_file IS NEW.pi_session_file
  AND OLD.workplace_folder_id IS NEW.workplace_folder_id
  AND OLD.workplace_revision IS NEW.workplace_revision
  AND OLD.routine_id IS NEW.routine_id
  AND OLD.internal_task_id IS NEW.internal_task_id
  AND OLD.acp_session IS NEW.acp_session
  AND OLD.yolo_at IS NEW.yolo_at
  AND OLD.created_at IS NEW.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'import_topic_read_only');
END;
CREATE TRIGGER import_run_read_only BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND import_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'import_topic_read_only');
END;
