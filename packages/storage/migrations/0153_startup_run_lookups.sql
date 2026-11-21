-- Session pages otherwise repeatedly scan all runs.
-- Keep the existing recovery queries and their watermarks unchanged.
CREATE INDEX IF NOT EXISTS runs_session_file ON runs(session_file) WHERE session_file IS NOT NULL;
-- The legacy existence sweep needs one lifecycle fact, not every event of each run.
CREATE INDEX IF NOT EXISTS run_events_created_run ON run_events(run_id) WHERE kind='run.created';
CREATE INDEX IF NOT EXISTS run_events_session_markers ON run_events(run_id,seq)
  WHERE kind IN ('session.synced','session.backfilled','session.interrupted');
