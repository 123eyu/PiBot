-- Findings a Bot reported with review_finding during a review run, shown on
-- their lines in the changes sidebar. run_id has no foreign key, like run_file_changes: rows are
-- written while the run executes. root is the run's primary folder; path is relative to it.
CREATE TABLE IF NOT EXISTS review_findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  group_id TEXT,
  conversation_id TEXT,
  root TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER CHECK(line IS NULL OR line > 0),
  end_line INTEGER CHECK(end_line IS NULL OR end_line > 0),
  severity TEXT NOT NULL CHECK(severity IN ('security','bug','suggestion')),
  message TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','dismissed','sent')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_findings_run ON review_findings(run_id, created_at);
CREATE INDEX IF NOT EXISTS review_findings_group ON review_findings(group_id, root, created_at);
CREATE INDEX IF NOT EXISTS review_findings_conversation ON review_findings(conversation_id, root, created_at);
CREATE INDEX IF NOT EXISTS review_findings_bot ON review_findings(bot_id, root, created_at);
CREATE INDEX IF NOT EXISTS review_findings_created ON review_findings(created_at);
