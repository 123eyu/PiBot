CREATE TABLE IF NOT EXISTS conversation_retry_boundaries (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  session_file TEXT NOT NULL,
  origin_message_id TEXT,
  entry_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_retries (
  request_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  source_conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','done','failed')),
  conversation_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_retries_source ON conversation_retries(source_conversation_id);
