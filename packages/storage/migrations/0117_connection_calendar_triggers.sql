-- pibot:rebuild-referenced-tables
-- Routine triggers that read a connection ("connection") or the local calendar
-- ("calendar"), and the run reasons they start. SQLite cannot widen a CHECK in place, so both
-- tables are rebuilt with every current column, index and constraint; the unattended views read
-- them and are dropped first and created again afterwards (0065's rule). 'github' stays allowed:
-- old triggers and runs remain readable history.
DROP VIEW IF EXISTS unattended_runs;
DROP VIEW IF EXISTS parked_unattended_runs;
DROP VIEW IF EXISTS unattended_definition_folders;
DROP VIEW IF EXISTS unattended_watched_paths;

CREATE TABLE routine_triggers_a26 (
  id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('cron','folder','once','github','connection','calendar')),
  config TEXT NOT NULL CHECK(json_valid(config)),
  cooldown_min INTEGER NOT NULL CHECK(cooldown_min BETWEEN 1 AND 60),
  state TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(state)), created_at TEXT NOT NULL,
  deleted_at TEXT
);
INSERT INTO routine_triggers_a26(id,routine_id,kind,config,cooldown_min,state,created_at,deleted_at)
  SELECT id,routine_id,kind,config,cooldown_min,state,created_at,deleted_at FROM routine_triggers;
DROP TABLE routine_triggers;
ALTER TABLE routine_triggers_a26 RENAME TO routine_triggers;
CREATE INDEX routine_triggers_routine ON routine_triggers(routine_id,created_at,id);

CREATE TABLE routine_runs_a26 (
  id TEXT PRIMARY KEY, routine_id TEXT,
  bot_id TEXT NOT NULL, trigger_id TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('cron','folder','once','github','connection','calendar','manual','trial','catchup')),
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
  attention_reason TEXT CHECK (attention_reason IS NULL OR length(attention_reason) BETWEEN 1 AND 200),
  resume_of TEXT REFERENCES routine_runs(id), occurrence_id TEXT REFERENCES routine_runs(id),
  period_key TEXT CHECK (period_key IS NULL OR length(period_key) BETWEEN 1 AND 40),
  CHECK(reason<>'trial' OR (routine_id IS NULL AND trial_draft IS NOT NULL)),
  CHECK(reason='trial' OR trial_draft IS NULL),
  CHECK((status='running' AND owner_token IS NOT NULL AND active_since IS NOT NULL) OR (status='waiting' AND active_since IS NULL) OR (status NOT IN ('running','waiting') AND owner_token IS NULL AND active_since IS NULL)),
  CHECK(status<>'waiting' OR (run_id IS NOT NULL AND waiting_since IS NOT NULL AND wait_expires_at IS NOT NULL AND wait_checkpoint IS NOT NULL)),
  CHECK(status<>'waiting' OR (owner_token IS NOT NULL AND json_type(wait_checkpoint,'$.drain')='null') OR (owner_token IS NULL AND json_type(wait_checkpoint,'$.drain')='object'))
);
INSERT INTO routine_runs_a26(id,routine_id,bot_id,trigger_id,reason,scheduled_for,queued_at,
  queue_expires_at,max_duration_min,started_at,finished_at,status,run_id,conversation_id,
  trigger_message_id,error_code,summary,allowed_ops,trial_draft,dedupe_key,active_ms,waiting_ms,
  active_since,waiting_since,wait_expires_at,owner_token,session_file,attempt,wait_checkpoint,
  decision_consumed_at,inbox_dismissed_at,created_at,attention_reason,resume_of,occurrence_id,
  period_key)
  SELECT id,routine_id,bot_id,trigger_id,reason,scheduled_for,queued_at,
  queue_expires_at,max_duration_min,started_at,finished_at,status,run_id,conversation_id,
  trigger_message_id,error_code,summary,allowed_ops,trial_draft,dedupe_key,active_ms,waiting_ms,
  active_since,waiting_since,wait_expires_at,owner_token,session_file,attempt,wait_checkpoint,
  decision_consumed_at,inbox_dismissed_at,created_at,attention_reason,resume_of,occurrence_id,
  period_key FROM routine_runs;
DROP TABLE routine_runs;
ALTER TABLE routine_runs_a26 RENAME TO routine_runs;
CREATE UNIQUE INDEX routine_runs_active ON routine_runs(routine_id) WHERE status IN ('scheduled','running','waiting');
CREATE INDEX routine_runs_page ON routine_runs(routine_id,created_at,id);
CREATE INDEX routine_runs_status ON routine_runs(status,created_at,id);
CREATE INDEX routine_runs_time ON routine_runs(scheduled_for,id);
CREATE INDEX routine_runs_history ON routine_runs(created_at,id);
CREATE INDEX routine_runs_bot_history ON routine_runs(bot_id,created_at,id);
CREATE INDEX routine_runs_trigger ON routine_runs(trigger_id,created_at,id);
CREATE INDEX routine_runs_topic_active ON routine_runs(conversation_id,status);
CREATE UNIQUE INDEX routine_runs_resume ON routine_runs(resume_of) WHERE resume_of IS NOT NULL;
CREATE INDEX routine_runs_occurrence ON routine_runs(occurrence_id) WHERE occurrence_id IS NOT NULL;
CREATE INDEX routine_runs_period ON routine_runs(routine_id,period_key,scheduled_for);

-- Same definitions as 0065.
CREATE VIEW unattended_runs AS
  SELECT id, run_id, bot_id, conversation_id, routine_id AS definition_id, status, reason,
    owner_token, decision_consumed_at, wait_checkpoint
  FROM routine_runs;
CREATE VIEW parked_unattended_runs AS
  SELECT r.id, r.run_id FROM routine_runs r WHERE
  r.status IN ('waiting','scheduled') AND r.owner_token IS NULL
  AND r.decision_consumed_at IS NULL
  AND json_extract(r.wait_checkpoint,'$.operationState')='unexecuted'
  AND json_extract(r.wait_checkpoint,'$.attempt')=r.attempt AND r.attempt>0
  AND json_type(r.wait_checkpoint,'$.permissionRevision')='integer'
  AND json_extract(r.wait_checkpoint,'$.permissionRevision')>=0
  AND json_type(r.wait_checkpoint,'$.permissionSnapshot.global.levels')='object'
  AND json_type(r.wait_checkpoint,'$.permissionSnapshot.effective.levels')='object'
  AND length(json_extract(r.wait_checkpoint,'$.operationHash'))=64
  AND json_extract(r.wait_checkpoint,'$.operationHash') NOT GLOB '*[^a-f0-9]*'
  AND json_extract(r.wait_checkpoint,'$.workspaceSnapshot.boundaryVersion')=1
  AND json_type(r.wait_checkpoint,'$.drain.at')='text'
  AND json_extract(r.wait_checkpoint,'$.drain.aborted')=1
  AND json_extract(r.wait_checkpoint,'$.drain.idle')=1
  AND json_extract(r.wait_checkpoint,'$.drain.jsonlDrained')=1
  AND json_extract(r.wait_checkpoint,'$.routineRunId')=r.id
  AND json_extract(r.wait_checkpoint,'$.botId')=r.bot_id
  AND json_extract(r.wait_checkpoint,'$.runId')=r.run_id
  AND json_extract(r.wait_checkpoint,'$.sessionFile')=r.session_file
  AND EXISTS(SELECT 1 FROM runs e WHERE e.id=r.run_id AND e.bot_id=r.bot_id
    AND e.status=CASE WHEN r.status='waiting' THEN 'waiting' ELSE 'queued' END
    AND e.session_file=r.session_file
    AND e.message_id=json_extract(r.wait_checkpoint,'$.messageId')
    AND e.conversation_id=json_extract(r.wait_checkpoint,'$.conversationId'))
  AND EXISTS(SELECT 1 FROM approvals a WHERE a.id=json_extract(r.wait_checkpoint,'$.approvalId')
    AND a.bot_id=r.bot_id AND a.message_id=json_extract(r.wait_checkpoint,'$.messageId')
    AND a.routine_run_id=r.id AND a.run_id=r.run_id AND a.status IN ('pending','allowed','denied','expired'));
CREATE VIEW unattended_definition_folders AS
  SELECT r.id AS definition_id, r.bot_id, json_extract(r.workplace,'$.folderId') AS folder_id,
    'primary' AS role
  FROM routines r WHERE r.deleted_at IS NULL AND json_valid(r.workplace)
    AND json_extract(r.workplace,'$.folderId') IS NOT NULL
  UNION ALL
  SELECT r.id, r.bot_id, json_extract(r.workplace,'$.cwd'), 'cwd'
  FROM routines r WHERE r.deleted_at IS NULL AND json_valid(r.workplace)
    AND json_extract(r.workplace,'$.cwd') IS NOT NULL
  UNION ALL
  SELECT r.id, r.bot_id, j.value, 'readonly'
  FROM routines r, json_each(r.workplace,'$.readonly') j
  WHERE r.deleted_at IS NULL AND json_valid(r.workplace)
  UNION ALL
  SELECT r.id, r.bot_id, f.id, 'watched'
  FROM routines r
  JOIN routine_triggers tr ON tr.routine_id=r.id AND tr.deleted_at IS NULL AND tr.kind='folder'
  JOIN working_folders f ON f.bot_id=r.bot_id AND f.path=json_extract(tr.config,'$.path')
  WHERE r.deleted_at IS NULL AND json_valid(r.workplace);
CREATE VIEW unattended_watched_paths AS
  SELECT json_extract(t.config,'$.path') AS path
  FROM routine_triggers t JOIN routines r ON r.id=t.routine_id
  WHERE t.deleted_at IS NULL AND r.deleted_at IS NULL AND t.kind='folder';

-- GitHub triggers are retired: every switched-on task that still has one is paused with the
-- existing trigger-error reason, so it shows under「触发器异常」, and the editor and list tell the
-- person to pick「连接有新内容」. The trigger row stays as the visible mark until they replace it.
-- A task the person switched off stays quietly off (the editor still shows the note, and it cannot
-- be switched on with the retired trigger); an archived Bot's task keeps that reason. Audited
-- like any other pause.
INSERT INTO audit_log(id,at,bot_id,kind,summary,detail,run_id)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),r.bot_id,'routine.paused','routine.paused',
       json_object('routineId',r.id,'source','routine','actor','system','reason','trigger_error',
         'reasonCode','github_trigger_retired'),NULL
FROM routines r
WHERE r.deleted_at IS NULL AND r.enabled=1 AND r.paused_reason IS NOT 'bot_archived'
  AND r.paused_reason IS NOT 'trigger_error'
  AND EXISTS (SELECT 1 FROM routine_triggers t WHERE t.routine_id=r.id AND t.deleted_at IS NULL
    AND t.kind='github');
UPDATE routines SET paused_reason='trigger_error',
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1
WHERE deleted_at IS NULL AND enabled=1 AND paused_reason IS NOT 'bot_archived'
  AND paused_reason IS NOT 'trigger_error'
  AND EXISTS (SELECT 1 FROM routine_triggers t WHERE t.routine_id=routines.id
    AND t.deleted_at IS NULL AND t.kind='github');
