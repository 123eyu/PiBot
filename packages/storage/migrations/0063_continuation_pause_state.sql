-- Phase 3: a parent continuation's pause must survive a
-- restart. Reason codes only; the pause summary is user/model text and stays in the message.
-- Existing rows keep 'unknown' and the restore path must fail closed instead of assuming "not
-- paused". `task_version` and `dispatched_run_id` pin an exact summary batch: a re-collected
-- set of finished tasks plus a trigger-key lookup is not proof that the batch was dispatched.
ALTER TABLE continuation_intents ADD COLUMN pause_state TEXT NOT NULL DEFAULT 'unknown'
  CHECK(pause_state IN ('clear','paused','unknown'));
ALTER TABLE continuation_intents ADD COLUMN pause_reason TEXT;
ALTER TABLE continuation_intents ADD COLUMN task_version INTEGER;
ALTER TABLE continuation_intents ADD COLUMN dispatched_run_id TEXT;
