CREATE TABLE group_member_workspaces (
  task_id TEXT PRIMARY KEY REFERENCES group_tasks(id) ON DELETE CASCADE,
  source_conversation_id TEXT NOT NULL REFERENCES conversations(id),
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL UNIQUE REFERENCES managed_worktrees(id),
  integration_path TEXT NOT NULL,
  workspace_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preparing','working','awaiting_integration','integrating','integrated','conflict','interrupted','removed')),
  error_code TEXT,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX group_member_workspaces_run ON group_member_workspaces(run_id);

ALTER TABLE group_tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'serial' CHECK(execution_mode IN ('serial','parallel'));
