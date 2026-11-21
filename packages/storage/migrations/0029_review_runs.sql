-- A review the user started from the changes sidebar, registered once when its run is known, so a
-- review that ends with no findings still supersedes the previous review's findings. Only
-- completed runs count (runs.status='done'); an aborted or failed review leaves the previous
-- findings showing. run_id has no foreign key, like review_findings. root is the primary folder.
CREATE TABLE IF NOT EXISTS review_runs (
  run_id TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  group_id TEXT,
  conversation_id TEXT,
  root TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, root)
);
CREATE INDEX IF NOT EXISTS review_runs_group ON review_runs(group_id, root, created_at);
CREATE INDEX IF NOT EXISTS review_runs_conversation ON review_runs(conversation_id, root, created_at);
CREATE INDEX IF NOT EXISTS review_runs_bot ON review_runs(bot_id, root, created_at);
CREATE INDEX IF NOT EXISTS review_runs_created ON review_runs(created_at);
