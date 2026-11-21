ALTER TABLE group_workflow_runs ADD COLUMN budget_root_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
CREATE INDEX group_workflow_runs_budget_root ON group_workflow_runs(budget_root_run_id)
  WHERE budget_root_run_id IS NOT NULL;
