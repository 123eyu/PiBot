CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  group_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('chat','group_task','wake')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','error','aborted')),
  message_id TEXT NOT NULL,
  user_message_id TEXT,
  task_id TEXT,
  cycle_id TEXT,
  automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1)),
  parent_run_id TEXT,
  after_run_id TEXT,
  ancestry TEXT NOT NULL DEFAULT '[]',
  trigger_key TEXT UNIQUE,
  session_file TEXT,
  stop_reason TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
-- IDs survive conversation deletion as execution history; no prompt or credentials are copied here.
CREATE INDEX runs_bot_queue ON runs(bot_id,status,created_at);
CREATE INDEX runs_group_queue ON runs(group_id,status,created_at);
CREATE INDEX runs_conversation ON runs(conversation_id,created_at);
CREATE UNIQUE INDEX runs_one_running_bot ON runs(bot_id) WHERE status='running';
CREATE TABLE group_cycles (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL,
  rounds INTEGER NOT NULL DEFAULT 0 CHECK(rounds>=0),
  limited INTEGER NOT NULL DEFAULT 0 CHECK(limited IN (0,1))
);
CREATE TABLE group_task_origins (
  task_id TEXT PRIMARY KEY REFERENCES group_tasks(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  source_tool_call_id TEXT,
  finished_run_id TEXT,
  wake_claimed INTEGER NOT NULL DEFAULT 0 CHECK(wake_claimed IN (0,1))
);
CREATE INDEX group_task_wakes_pending ON group_task_origins(task_id)
  WHERE wake_claimed=0 AND finished_run_id IS NOT NULL;

ALTER TABLE attachments ADD COLUMN source_attachment_id TEXT;
