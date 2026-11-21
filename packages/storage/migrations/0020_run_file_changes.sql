-- "This turn": what write/edit tools changed (content refs) and what commands touched (paths only).
-- run_id has no foreign key: rows are written while the run executes, including routine runs.
CREATE TABLE IF NOT EXISTS run_file_changes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  root TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('add','modify','delete','command')),
  before_ref TEXT CHECK(before_ref IS NULL OR length(before_ref) = 64),
  after_ref TEXT CHECK(after_ref IS NULL OR length(after_ref) = 64),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_file_changes_run ON run_file_changes(run_id, created_at);
CREATE INDEX IF NOT EXISTS run_file_changes_bot ON run_file_changes(bot_id, created_at);
CREATE INDEX IF NOT EXISTS run_file_changes_created ON run_file_changes(created_at);
