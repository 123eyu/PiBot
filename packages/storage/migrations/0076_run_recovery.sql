-- What a run needs to come back after a restart, kept beside `runs` so that table is not
-- rebuilt. `root_run_id` is the budget / journal root of a resumed run (its own id otherwise, so
-- the column stays NULL); `resumed_from` is the interrupted run it continues. `workflow_json` is
-- the workflow identity (skill id and version, parameters, inputs, this and the previous period
-- folder, contract budget): never the skill body, which is read again from the skill file.
CREATE TABLE IF NOT EXISTS run_recovery (
  run_id TEXT PRIMARY KEY,
  root_run_id TEXT,
  resumed_from TEXT,
  workflow_json TEXT CHECK (workflow_json IS NULL OR length(workflow_json) <= 200000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_recovery_resumed ON run_recovery(resumed_from)
  WHERE resumed_from IS NOT NULL;
