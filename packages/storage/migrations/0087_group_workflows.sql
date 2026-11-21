-- Durable group execution DAG state. The tables are the scheduling truth; run ordering is
-- still expressed with runs.after_run_id, but never reconstructed from it.
CREATE TABLE IF NOT EXISTS group_workflow_runs (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  contract_version INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','waiting','passed','failed','cancelled')),
  initiator_bot_id TEXT NOT NULL REFERENCES bots(id),
  coordinator_bot_id TEXT NOT NULL REFERENCES bots(id),
  cycle_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL REFERENCES messages(id),
  workflow_json TEXT NOT NULL CHECK(json_valid(workflow_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS group_workflow_steps (
  workflow_run_id TEXT NOT NULL REFERENCES group_workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('waiting','ready','running','passed','failed','blocked','skipped')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  task_id TEXT REFERENCES group_tasks(id) ON DELETE SET NULL,
  execution_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  deliverables_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(deliverables_json)),
  owner_bot_id TEXT NOT NULL REFERENCES bots(id),
  decision_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workflow_run_id, step_id)
);

CREATE INDEX IF NOT EXISTS group_workflow_runs_group_status
  ON group_workflow_runs(group_id, status, updated_at);
CREATE INDEX IF NOT EXISTS group_workflow_steps_run_status
  ON group_workflow_steps(workflow_run_id, status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS group_workflow_steps_task
  ON group_workflow_steps(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_workflow_steps_running
  ON group_workflow_steps(workflow_run_id,step_id) WHERE status='running';
