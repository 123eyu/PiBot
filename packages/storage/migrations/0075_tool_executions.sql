-- Execution journal of non-read tool calls (write-ahead: `started` before dispatch, a
-- terminal state after). Digests and a short redacted summary only: never arguments, file
-- contents or message bodies. One row per idempotency key; an explicit failure is retried on the
-- same row (`attempts`).
CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  -- Scope of replay detection: the routine occurrence, else the budget root run.
  root_run_id TEXT NOT NULL,
  -- Which attempt counts this row for the "n-th identical call" ordinal (a routine attempt, or
  -- the root itself when there are no attempts).
  attempt_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL CHECK (length(tool_call_id) BETWEEN 1 AND 200),
  tool TEXT NOT NULL CHECK (length(tool) BETWEEN 1 AND 80),
  effect_class TEXT NOT NULL CHECK (effect_class IN ('idempotent','local_effect','external')),
  args_digest TEXT NOT NULL CHECK (length(args_digest) = 64),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) = 64),
  state TEXT NOT NULL CHECK (state IN ('started','done','failed','unknown')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  result_summary TEXT CHECK (result_summary IS NULL OR length(result_summary) <= 600),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS tool_executions_identity
  ON tool_executions(root_run_id, tool, args_digest, ordinal);
CREATE INDEX IF NOT EXISTS tool_executions_run ON tool_executions(run_id, created_at, id);
CREATE INDEX IF NOT EXISTS tool_executions_open ON tool_executions(state) WHERE state = 'started';
