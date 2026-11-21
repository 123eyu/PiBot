CREATE TABLE IF NOT EXISTS tool_diagnostics (
  tool_record_id TEXT PRIMARY KEY REFERENCES tool_calls(id) ON DELETE CASCADE,
  error_code TEXT,
  result_count INTEGER CHECK(result_count IS NULL OR result_count >= 0),
  connector_id TEXT
);
CREATE TABLE IF NOT EXISTS run_diagnostics (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  unfinished_todo_count INTEGER NOT NULL CHECK(unfinished_todo_count >= 0)
);
CREATE TABLE IF NOT EXISTS connector_diagnostics (
  connector_id TEXT PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  error_code TEXT,
  native_status INTEGER CHECK(native_status IS NULL OR native_status BETWEEN 0 AND 4),
  observed_at TEXT NOT NULL,
  native_observed_at TEXT,
  last_error_at TEXT
);

CREATE INDEX IF NOT EXISTS diagnostics_tools_recent ON tool_calls(created_at DESC);
CREATE INDEX IF NOT EXISTS diagnostics_runs_recent ON runs(created_at DESC);
