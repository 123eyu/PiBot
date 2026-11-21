-- Historical duplicate tasks may refer to one delivery without reposting it.
CREATE TABLE group_task_results (
  task_id TEXT PRIMARY KEY REFERENCES group_tasks(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX group_task_results_message ON group_task_results(message_id);
INSERT INTO group_task_results(task_id,message_id)
SELECT task_result_id,id FROM messages WHERE task_result_id IS NOT NULL;
CREATE INDEX group_tasks_open_owner ON group_tasks(group_id,assignee_bot_id,created_at,id) WHERE status='open';
CREATE INDEX runs_user_reply ON runs(group_id,user_message_id,bot_id,kind,automatic);
