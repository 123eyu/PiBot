-- Internal sessions are not user topics and may only be opened through the task history API.
ALTER TABLE conversations ADD COLUMN internal_task_id TEXT;
CREATE UNIQUE INDEX conversations_internal_task ON conversations(internal_task_id)
  WHERE internal_task_id IS NOT NULL;
CREATE TABLE task_instances (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_task_id TEXT REFERENCES task_instances(id) ON DELETE CASCADE,
  root_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  internal_conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) BETWEEN 1 AND 300),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  prompt TEXT NOT NULL CHECK(length(prompt) BETWEEN 1 AND 16000),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json)),
  depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 4),
  status TEXT NOT NULL CHECK(status IN ('queued','running','stopping','done','error','aborted','interrupted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), result TEXT CHECK(length(result)<=16000),
  result_truncated INTEGER NOT NULL DEFAULT 0 CHECK(result_truncated IN (0,1)),
  needs_verification INTEGER NOT NULL DEFAULT 0 CHECK(needs_verification IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(parent_run_id, tool_call_id)
);
CREATE INDEX task_source_page ON task_instances(bot_id,source_conversation_id,created_at DESC,id DESC);
CREATE INDEX task_root_status ON task_instances(root_run_id,status);
CREATE INDEX task_parent ON task_instances(parent_task_id);
CREATE TABLE task_attempts (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES task_instances(id) ON DELETE CASCADE,
  internal_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK(attempt>=1), created_at TEXT NOT NULL, UNIQUE(task_id,attempt)
);
CREATE TABLE task_messages (
  task_id TEXT NOT NULL REFERENCES task_instances(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 300),
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 8000),
  state TEXT NOT NULL CHECK(state IN ('pending','delivered')), created_at TEXT NOT NULL,
  PRIMARY KEY(task_id,request_id)
);
CREATE TABLE execution_budgets (
  root_run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), updated_at TEXT NOT NULL
);
CREATE TABLE budget_events (
  root_run_id TEXT NOT NULL REFERENCES execution_budgets(root_run_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 300),
  kind TEXT NOT NULL CHECK(kind IN ('tool','model','child')),
  settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)), updated_at TEXT NOT NULL,
  PRIMARY KEY(root_run_id,event_id)
);
CREATE TABLE execution_checkpoints (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json))
);
