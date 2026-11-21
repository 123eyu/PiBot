-- Rebuild only to widen frozen earlier CHECKs; execution history and the running slot stay intact.
CREATE TABLE runs_m3 (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL, group_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('chat','group_task','wake','routine')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','done','error','aborted')),
  message_id TEXT NOT NULL, user_message_id TEXT, task_id TEXT, cycle_id TEXT,
  automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1)), parent_run_id TEXT,
  after_run_id TEXT, ancestry TEXT NOT NULL DEFAULT '[]', trigger_key TEXT UNIQUE,
  session_file TEXT, stop_reason TEXT, error_code TEXT, created_at TEXT NOT NULL,
  started_at TEXT, finished_at TEXT
);
INSERT INTO runs_m3 SELECT * FROM runs;
DROP TABLE runs;
ALTER TABLE runs_m3 RENAME TO runs;
CREATE INDEX runs_bot_queue ON runs(bot_id,status,created_at);
CREATE INDEX runs_group_queue ON runs(group_id,status,created_at);
CREATE INDEX runs_conversation ON runs(conversation_id,created_at);
CREATE UNIQUE INDEX runs_one_running_bot ON runs(bot_id) WHERE status='running';

CREATE TABLE routines (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 40),
  instructions TEXT NOT NULL CHECK(length(instructions) BETWEEN 1 AND 4000),
  workplace TEXT NOT NULL CHECK(json_valid(workplace)),
  notify TEXT NOT NULL CHECK(notify IN ('always','on_attention','never')),
  max_duration_min INTEGER NOT NULL CHECK(max_duration_min BETWEEN 5 AND 120),
  carry_last_result INTEGER NOT NULL CHECK(carry_last_result IN (0,1)),
  missed_policy TEXT CHECK(missed_policy IN ('catchup','skip','ask')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  paused_reason TEXT CHECK(paused_reason IN ('away_7d','bot_archived','trigger_error')),
  last_scheduled_at TEXT, topic_conversation_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX routines_bot_page ON routines(bot_id,created_at,id);
CREATE INDEX routines_enabled ON routines(enabled,paused_reason,deleted_at);
ALTER TABLE conversations ADD COLUMN routine_id TEXT;
CREATE UNIQUE INDEX conversations_routine ON conversations(routine_id) WHERE routine_id IS NOT NULL;
ALTER TABLE messages ADD COLUMN routine_trigger TEXT CHECK(routine_trigger IS NULL OR json_valid(routine_trigger));
CREATE TABLE routine_triggers (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('cron','folder')), config TEXT NOT NULL CHECK(json_valid(config)),
  cooldown_min INTEGER NOT NULL CHECK(cooldown_min BETWEEN 1 AND 60),
  state TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(state)), created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX routine_triggers_routine ON routine_triggers(routine_id,created_at,id);
CREATE TABLE routine_preauth (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  category TEXT NOT NULL, scope TEXT NOT NULL CHECK(json_valid(scope)),
  workspace_snapshot TEXT CHECK(workspace_snapshot IS NULL OR json_valid(workspace_snapshot)),
  created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE UNIQUE INDEX routine_preauth_active ON routine_preauth(routine_id,category,scope) WHERE revoked_at IS NULL;
CREATE INDEX routine_preauth_page ON routine_preauth(created_at,id);
CREATE TABLE routine_runs (
  id TEXT PRIMARY KEY, routine_id TEXT,
  bot_id TEXT NOT NULL, trigger_id TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('cron','folder','manual','trial','catchup')),
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
CREATE UNIQUE INDEX routine_runs_active ON routine_runs(routine_id) WHERE status IN ('scheduled','running','waiting');
CREATE INDEX routine_runs_page ON routine_runs(routine_id,created_at,id);
CREATE INDEX routine_runs_status ON routine_runs(status,created_at,id);
CREATE INDEX routine_runs_time ON routine_runs(scheduled_for,id);
CREATE TABLE routine_proposals (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  status TEXT NOT NULL CHECK(status IN ('open','accepted','declined','expired')),
  resolved_routine_id TEXT, dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX routine_proposals_page ON routine_proposals(bot_id,created_at,id);
CREATE INDEX routine_proposals_open ON routine_proposals(status,created_at,id);
CREATE TABLE power_events (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('suspend','resume','start','on-ac','on-battery','lock-screen','unlock-screen')),
  at TEXT NOT NULL
);
CREATE INDEX power_events_at ON power_events(at,id);
ALTER TABLE approvals ADD COLUMN routine_run_id TEXT REFERENCES routine_runs(id);
ALTER TABLE approvals ADD COLUMN source TEXT NOT NULL DEFAULT 'chat' CHECK(source IN ('chat','routine','trial'));
DROP INDEX approvals_bot_pending;
CREATE UNIQUE INDEX approvals_bot_chat_pending ON approvals(bot_id) WHERE status='pending' AND source='chat';
CREATE UNIQUE INDEX approvals_run_pending ON approvals(run_id) WHERE status='pending';
CREATE INDEX approvals_routine_run ON approvals(routine_run_id,status);
CREATE TRIGGER approvals_source_insert BEFORE INSERT ON approvals BEGIN
  SELECT RAISE(ABORT,'Invalid approval source') WHERE (NEW.source='chat')<>(NEW.routine_run_id IS NULL);
END;
CREATE TRIGGER approvals_source_update BEFORE UPDATE OF source,routine_run_id ON approvals BEGIN
  SELECT RAISE(ABORT,'Invalid approval source') WHERE (NEW.source='chat')<>(NEW.routine_run_id IS NULL);
END;
ALTER TABLE working_folders ADD COLUMN association TEXT NOT NULL DEFAULT 'user' CHECK(association IN ('user','monitor'));
ALTER TABLE bot_workplace ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0);
CREATE TABLE group_workspace (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  primary_folder_id TEXT, primary_initialized INTEGER NOT NULL DEFAULT 0 CHECK(primary_initialized IN (0,1)), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  FOREIGN KEY(group_id,primary_folder_id) REFERENCES group_folders(group_id,id)
);
-- Existing first root remains primary. Removal falls back to legacy Bot home instead of promoting another root.
CREATE UNIQUE INDEX group_folders_owner_id ON group_folders(group_id,id);
INSERT INTO group_workspace(group_id,primary_folder_id,primary_initialized)
  SELECT g.id,(SELECT f.id FROM group_folders f WHERE f.group_id=g.id ORDER BY position,id LIMIT 1),EXISTS(SELECT 1 FROM group_folders f WHERE f.group_id=g.id) FROM groups g;
INSERT INTO settings(key,value) VALUES ('routines.missedPolicy','"catchup"'),('routines.keepAwake','"on_ac"'),('routines.pauseWhenAway','true'),('routines.pausedUntil','null'),('ui.lastActiveAt','null') ON CONFLICT(key) DO NOTHING;
