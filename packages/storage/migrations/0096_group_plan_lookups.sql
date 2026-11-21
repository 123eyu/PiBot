-- Plan-card lookup by cycle and a workflow step's earlier attempts were full scans of a
-- group conversation's messages / every hand-off. Expression indexes only; no data changes.
CREATE INDEX IF NOT EXISTS messages_group_plan_cycle
  ON messages(conversation_id, json_extract(usage, '$.groupPlan.cycleId'))
  WHERE json_extract(usage, '$.groupPlan.cycleId') IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_task_handoffs_workflow_step
  ON group_task_handoffs(
    json_extract(spec, '$.workflowStep.workflowRunId'),
    json_extract(spec, '$.workflowStep.stepId')
  )
  WHERE json_extract(spec, '$.workflowStep.workflowRunId') IS NOT NULL;
