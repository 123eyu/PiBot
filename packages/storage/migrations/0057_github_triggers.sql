-- pibot:rebuild-referenced-tables
-- The migration runner disables connection-local FKs before BEGIN and verifies all references before COMMIT.
CREATE TABLE routine_triggers_github (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('cron','folder','once','github')), config TEXT NOT NULL CHECK(json_valid(config)),
  cooldown_min INTEGER NOT NULL CHECK(cooldown_min BETWEEN 1 AND 60),
  state TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(state)), created_at TEXT NOT NULL,
  deleted_at TEXT
);
INSERT INTO routine_triggers_github SELECT * FROM routine_triggers;
DROP TABLE routine_triggers;
ALTER TABLE routine_triggers_github RENAME TO routine_triggers;
CREATE INDEX routine_triggers_routine ON routine_triggers(routine_id,created_at,id);
CREATE TABLE routine_runs_github (
  id TEXT PRIMARY KEY, routine_id TEXT,
  bot_id TEXT NOT NULL, trigger_id TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('cron','folder','once','github','manual','trial','catchup')),
  scheduled_for TEXT NOT NULL, queued_at TEXT, queue_expires_at TEXT, max_duration_min INTEGER NOT NULL CHECK(max_duration_min BETWEEN 5 AND 120), started_at TEXT, finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('scheduled','running','waiting','done','failed','cancelled','timeout','missed','skipped_overlap','skipped_missed')),
  run_id TEXT UNIQUE REFERENCES runs(id), conversation_id TEXT, trigger_message_id TEXT,
  error_code TEXT, summary TEXT CHECK(length(summary)<=2000),
  allowed_ops TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allowed_ops)),
  trial_draft TEXT CHECK(trial_draft IS NULL OR json_valid(trial_draft)),
  dedupe_key TEXT NOT NULL UNIQUE,
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_ms>=0),
  waiting_ms INTEGER NOT NULL DEFAULT 0 CHECK(waiting_ms>=0),
  active_since TEXT, waiting_since TEXT, wait_expires_at TEXT,
  owner_token TEXT, session_file TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0),
  wait_checkpoint TEXT CHECK(wait_checkpoint IS NULL OR json_valid(wait_checkpoint)), decision_consumed_at TEXT, inbox_dismissed_at TEXT, created_at TEXT NOT NULL,
  CHECK(reason<>'trial' OR (routine_id IS NULL AND trial_draft IS NOT NULL)),
  CHECK(reason='trial' OR trial_draft IS NULL),
  CHECK((status='running' AND owner_token IS NOT NULL AND active_since IS NOT NULL) OR (status='waiting' AND active_since IS NULL) OR (status NOT IN ('running','waiting') AND owner_token IS NULL AND active_since IS NULL)),
  CHECK(status<>'waiting' OR (run_id IS NOT NULL AND waiting_since IS NOT NULL AND wait_expires_at IS NOT NULL AND wait_checkpoint IS NOT NULL)),
  CHECK(status<>'waiting' OR (owner_token IS NOT NULL AND json_type(wait_checkpoint,'$.drain')='null') OR (owner_token IS NULL AND json_type(wait_checkpoint,'$.drain')='object'))
);
INSERT INTO routine_runs_github SELECT * FROM routine_runs;
DROP TABLE routine_runs;
ALTER TABLE routine_runs_github RENAME TO routine_runs;
CREATE UNIQUE INDEX routine_runs_active ON routine_runs(routine_id) WHERE status IN ('scheduled','running','waiting');
CREATE INDEX routine_runs_page ON routine_runs(routine_id,created_at,id);
CREATE INDEX routine_runs_status ON routine_runs(status,created_at,id);
CREATE INDEX routine_runs_time ON routine_runs(scheduled_for,id);
-- Global and original-Bot history must seek without scanning each task or day.
CREATE INDEX IF NOT EXISTS routine_runs_history ON routine_runs(created_at,id);
CREATE INDEX IF NOT EXISTS routine_runs_bot_history ON routine_runs(bot_id,created_at,id);
CREATE INDEX routine_runs_trigger ON routine_runs(trigger_id,created_at,id);

CREATE INDEX routine_runs_topic_active ON routine_runs(conversation_id,status);
