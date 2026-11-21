-- Post-hoc memory extraction runs on its own queue so a restart resumes exactly where it
-- stopped. One open row per topic makes enqueueing idempotent; the row also carries the watermark
-- (the newest message it covered) so an unchanged topic is never sent to the model twice.
CREATE TABLE IF NOT EXISTS memory_extractions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  group_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','skipped')),
  reason TEXT NOT NULL CHECK(reason IN ('idle','archive')),
  coverage_message_id TEXT,
  model_provider TEXT,
  model_id TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
-- A topic has at most one pending or running extraction; the second enqueue is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS memory_extractions_open
  ON memory_extractions(conversation_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS memory_extractions_queue
  ON memory_extractions(status, created_at, id);
CREATE INDEX IF NOT EXISTS memory_extractions_bot_day
  ON memory_extractions(bot_id, created_at);
