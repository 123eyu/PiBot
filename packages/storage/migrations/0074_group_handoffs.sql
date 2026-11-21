-- Structured hand-offs (assign_task with expectedOutput / doneWhen). One row per group
-- task that is a hand-off: the program-built spec, the coordinator's workflow it belongs to, the
-- folder its files resolve in, the program's check when the member finished and its outcome.
-- Paths, ids and statuses only; never message text or file contents.
CREATE TABLE IF NOT EXISTS group_task_handoffs (
  task_id TEXT PRIMARY KEY REFERENCES group_tasks(id) ON DELETE CASCADE,
  spec TEXT NOT NULL CHECK (json_valid(spec)),
  pipeline TEXT CHECK (pipeline IS NULL OR json_valid(pipeline)),
  base_folder TEXT,
  return_of TEXT REFERENCES group_tasks(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','met','returned','unmet')),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  wake_run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS group_task_handoffs_wake ON group_task_handoffs(wake_run_id)
  WHERE wake_run_id IS NOT NULL;
-- Hand-offs have their own per-cycle cap; automatic rounds keep bounding free discussion.
ALTER TABLE group_cycles ADD COLUMN handoffs INTEGER NOT NULL DEFAULT 0 CHECK (handoffs >= 0);
