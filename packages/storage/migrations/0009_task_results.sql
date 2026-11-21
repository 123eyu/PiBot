ALTER TABLE messages ADD COLUMN task_result_id TEXT REFERENCES group_tasks(id) ON DELETE SET NULL;
-- A result is display-only and must survive restart without being published twice.
CREATE UNIQUE INDEX messages_one_task_result ON messages(task_result_id) WHERE task_result_id IS NOT NULL;
CREATE INDEX approvals_run_completion ON approvals(run_id,status);
