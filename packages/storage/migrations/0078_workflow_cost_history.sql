-- The run form's cost estimate reads the last finished runs of one workflow skill. Their
-- identity is in run_recovery.workflow_json; this index keeps that lookup to the skill's own rows
-- instead of scanning every workflow run. Same expression as RunRecoveryRepo.workflowCosts.
CREATE INDEX IF NOT EXISTS run_recovery_workflow_skill
  ON run_recovery(json_extract(workflow_json, '$.skillId'))
  WHERE workflow_json IS NOT NULL;
