-- Commands a Bot started in background mode. `processes` records pid + start time (and the
-- POSIX process group) so a restarted brain can stop exactly these processes, never a recycled
-- pid. conversation_id / group_id have no foreign key: brain stops the commands before deleting
-- a chat, and the row must survive as the only record of what to clean up after a crash.
CREATE TABLE IF NOT EXISTS background_commands (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT,
  group_id TEXT,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  command TEXT NOT NULL,
  log_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','exited','stopped','failed')),
  stop_reason TEXT,
  exit_code INTEGER,
  process_group INTEGER,
  processes TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS background_commands_bot ON background_commands(bot_id, started_at);
CREATE INDEX IF NOT EXISTS background_commands_status ON background_commands(status);
