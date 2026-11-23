-- Preserve old attempts while allowing one durable successor behind a running extraction.
CREATE TABLE memory_extractions_next (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  group_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','skipped')),
  reason TEXT NOT NULL CHECK(reason IN ('idle','archive','boundary','correction')),
  priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 2),
  source_message_id TEXT,
  coverage_message_id TEXT,
  model_provider TEXT,
  model_id TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  raw_candidates INTEGER NOT NULL DEFAULT 0,
  valid_candidates INTEGER NOT NULL DEFAULT 0,
  applied_candidates INTEGER NOT NULL DEFAULT 0,
  proposed_candidates INTEGER NOT NULL DEFAULT 0,
  reason_counts TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO memory_extractions_next (
  id, bot_id, conversation_id, group_id, status, reason, coverage_message_id, model_provider,
  model_id, tokens, cost_usd, candidates, error, created_at, started_at, finished_at,
  raw_candidates, valid_candidates, applied_candidates, proposed_candidates, reason_counts
)
SELECT id, bot_id, conversation_id, group_id, status, reason, coverage_message_id, model_provider,
  model_id, tokens, cost_usd, candidates, error, created_at, started_at, finished_at,
  raw_candidates, valid_candidates, applied_candidates, proposed_candidates, reason_counts
FROM memory_extractions ORDER BY rowid;
DROP TABLE memory_extractions;
ALTER TABLE memory_extractions_next RENAME TO memory_extractions;
CREATE UNIQUE INDEX memory_extractions_queued ON memory_extractions(conversation_id) WHERE status='queued';
CREATE UNIQUE INDEX memory_extractions_running ON memory_extractions(conversation_id) WHERE status='running';
CREATE INDEX memory_extractions_queue ON memory_extractions(status, priority DESC, created_at, id);
CREATE INDEX memory_extractions_bot_day ON memory_extractions(bot_id, created_at);
CREATE INDEX memory_extractions_started ON memory_extractions(started_at, bot_id);
CREATE INDEX memory_extractions_topic ON memory_extractions(conversation_id, status, finished_at);
CREATE INDEX memory_extractions_bot_results ON memory_extractions(bot_id, finished_at DESC, id DESC)
  WHERE status='done';
