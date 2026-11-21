CREATE TABLE worktree_allocations (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL, parent_path TEXT NOT NULL, identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
  expires_at TEXT NOT NULL, consumed_by TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE INDEX worktree_allocation_scope ON worktree_allocations(bot_id,scope_key,expires_at);
CREATE TABLE managed_worktrees (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL, path TEXT NOT NULL UNIQUE, common_dir TEXT NOT NULL,
  branch TEXT NOT NULL UNIQUE, base_head TEXT NOT NULL, head TEXT,
  source_identity_json TEXT NOT NULL CHECK(json_valid(source_identity_json)),
  identity_json TEXT CHECK(identity_json IS NULL OR json_valid(identity_json)),
  state TEXT NOT NULL CHECK(state IN ('creating','ready','integrating','removing','removed','interrupted','conflict')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX managed_worktree_source ON managed_worktrees(bot_id,source_path,created_at DESC,id DESC);
CREATE TABLE managed_git_operations (
  id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES managed_worktrees(id),
  kind TEXT NOT NULL CHECK(kind IN ('create','integrate','remove')),
  state TEXT NOT NULL CHECK(state IN ('intent','running','done','conflict','interrupted')),
  expected_json TEXT NOT NULL CHECK(json_valid(expected_json)), observed_json TEXT CHECK(observed_json IS NULL OR json_valid(observed_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX managed_git_recovery ON managed_git_operations(state,created_at);
CREATE TABLE file_checkpoints (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, scope_key TEXT NOT NULL,
  root TEXT NOT NULL, identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
  state TEXT NOT NULL CHECK(state IN ('available','partial','expired')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
  created_at TEXT NOT NULL, UNIQUE(run_id,root)
);
CREATE INDEX file_checkpoint_scope ON file_checkpoints(bot_id,scope_key,created_at DESC,id DESC);
CREATE TABLE file_checkpoint_items (
  id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL REFERENCES file_checkpoints(id) ON DELETE CASCADE,
  path TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('add','modify','delete','command')),
  before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK(after_json IS NULL OR json_valid(after_json)),
  reason TEXT CHECK(reason IN ('snapshot_missing','command','unsafe_path','quota')),
  UNIQUE(checkpoint_id,path)
);
CREATE TABLE file_restore_operations (
  id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL REFERENCES file_checkpoints(id),
  state TEXT NOT NULL CHECK(state IN ('intent','running','done','conflict','interrupted')),
  recovery_path TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX file_restore_recovery ON file_restore_operations(state,created_at);
CREATE TABLE file_restore_items (
  restore_id TEXT NOT NULL REFERENCES file_restore_operations(id),
  item_id TEXT NOT NULL REFERENCES file_checkpoint_items(id),
  state TEXT NOT NULL CHECK(state IN ('pending','restored','conflict','interrupted')),
  PRIMARY KEY(restore_id,item_id)
);
ALTER TABLE run_file_changes ADD COLUMN before_mode INTEGER CHECK(before_mode IS NULL OR before_mode BETWEEN 0 AND 511);
ALTER TABLE run_file_changes ADD COLUMN after_mode INTEGER CHECK(after_mode IS NULL OR after_mode BETWEEN 0 AND 511);
ALTER TABLE run_file_changes ADD COLUMN root_device TEXT;
ALTER TABLE run_file_changes ADD COLUMN root_inode TEXT;
CREATE TABLE managed_worktree_bindings (
  scope_key TEXT PRIMARY KEY, worktree_id TEXT NOT NULL REFERENCES managed_worktrees(id),
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  identity_json TEXT NOT NULL CHECK(json_valid(identity_json)), updated_at TEXT NOT NULL
);
CREATE INDEX managed_binding_tree ON managed_worktree_bindings(worktree_id);
