-- Memory organization runs on its own durable queue. A run is scoped to one memory owner
-- (the shared user notes or one Bot's own notes), not to a topic, so the row keeps its own
-- bookkeeping: when it finished, which model, what it cost, and how many proposals it produced.
-- The open index makes enqueueing idempotent per owner and also serializes two Bots from
-- organizing the same shared user memory at the same time.
CREATE TABLE IF NOT EXISTS memory_organizations (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('user','bot')),
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','skipped')),
  reason TEXT NOT NULL CHECK(reason IN ('count','stale')),
  model_provider TEXT,
  model_id TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  proposals INTEGER NOT NULL DEFAULT 0,
  memory_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_organizations_open
  ON memory_organizations(scope, owner_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS memory_organizations_queue
  ON memory_organizations(status, created_at, id);
CREATE INDEX IF NOT EXISTS memory_organizations_owner
  ON memory_organizations(scope, owner_id, finished_at);
CREATE INDEX IF NOT EXISTS memory_organizations_bot_day
  ON memory_organizations(bot_id, created_at);
