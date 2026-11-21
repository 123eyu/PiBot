-- Routines became a capability package and own their tables. The kernel reads unattended
-- runs only through these views, which are the data contract between the two: kernel code names
-- no routine table. A change of meaning needs a new migration (DROP VIEW + CREATE VIEW), and a
-- migration that rebuilds routines, routine_runs or routine_triggers (drop + rename) must drop
-- these views first and create them again afterwards.

-- Every unattended run, in the columns the kernel uses (topic busy, approval identity, message
-- read scope, restart recovery of streaming messages).
CREATE VIEW IF NOT EXISTS unattended_runs AS
  SELECT id, run_id, bot_id, conversation_id, routine_id AS definition_id, status, reason,
    owner_token, decision_consumed_at, wait_checkpoint
  FROM routine_runs;

-- Runs safely parked across a restart (committed adapter assertions only; the owner revalidates
-- at resume). Their tool calls and approvals survive startup recovery.
CREATE VIEW IF NOT EXISTS parked_unattended_runs AS
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

-- Folders a live definition depends on, by role. Workplace JSON is always written through the
-- validated schema; json_valid only keeps a corrupt row from failing every query.
CREATE VIEW IF NOT EXISTS unattended_definition_folders AS
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

-- Paths folder triggers of live definitions watch (they may be outside registered folders).
CREATE VIEW IF NOT EXISTS unattended_watched_paths AS
  SELECT json_extract(t.config,'$.path') AS path
  FROM routine_triggers t JOIN routines r ON r.id=t.routine_id
  WHERE t.deleted_at IS NULL AND r.deleted_at IS NULL AND t.kind='folder';
