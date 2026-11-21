-- Routine run ledger and per-period artifact folders.
-- Columns are added (no rebuild), so the 0065 views and the 0066 column stay as they are.

-- Artifact folder settings of a routine (JSON {enabled, folder, period}); NULL reads as defaults.
ALTER TABLE routines ADD COLUMN output TEXT CHECK (output IS NULL OR json_valid(output));

-- A manual resume continues one failed run as the same occurrence; each run is resumed at most once.
ALTER TABLE routine_runs ADD COLUMN resume_of TEXT REFERENCES routine_runs(id);
ALTER TABLE routine_runs ADD COLUMN occurrence_id TEXT REFERENCES routine_runs(id);
ALTER TABLE routine_runs ADD COLUMN period_key TEXT CHECK (period_key IS NULL OR length(period_key) BETWEEN 1 AND 40);
CREATE UNIQUE INDEX IF NOT EXISTS routine_runs_resume ON routine_runs(resume_of) WHERE resume_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS routine_runs_occurrence ON routine_runs(occurrence_id) WHERE occurrence_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS routine_runs_period ON routine_runs(routine_id,period_key,scheduled_for);

-- Facts of one run, apart from the chat transcript: inputs it processed, files it produced and
-- external sends it intended (with an idempotency key per send). No content, no message bodies.
CREATE TABLE IF NOT EXISTS routine_run_ledger (
  routine_run_id TEXT NOT NULL REFERENCES routine_runs(id) ON DELETE CASCADE,
  occurrence_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('context','input','output','send')),
  item_key TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 1024),
  facts TEXT NOT NULL CHECK (json_valid(facts) AND length(CAST(facts AS BLOB)) <= 65536),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (routine_run_id, kind, item_key)
);
CREATE INDEX IF NOT EXISTS routine_run_ledger_occurrence ON routine_run_ledger(occurrence_id,kind,item_key);
