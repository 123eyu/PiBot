CREATE TABLE IF NOT EXISTS background_completion_runs (
  job_id TEXT PRIMARY KEY REFERENCES background_commands(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS background_completion_run ON background_completion_runs(run_id);
CREATE INDEX IF NOT EXISTS background_restart_unverified ON background_commands(id)
  WHERE stop_reason='restart_unverified';
