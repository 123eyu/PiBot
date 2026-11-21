-- Every brain start runs crash-recovery statements that look for unfinished rows
-- (`messages.status='streaming'`, `runs.status IN ('queued','running','waiting')`). Without an
-- index each one scanned the whole table; on a 50 MB database the messages scan alone took
-- 0.1–0.6 s per statement. Partial indexes hold only the few unfinished rows, so they stay tiny
-- and the recovery queries become index lookups. The WHERE clauses repeat the queries' terms
-- verbatim so SQLite's planner can prove they apply.
CREATE INDEX IF NOT EXISTS messages_streaming ON messages(id) WHERE status = 'streaming';
CREATE INDEX IF NOT EXISTS runs_unfinished ON runs(status)
  WHERE status IN ('queued','running','waiting');
