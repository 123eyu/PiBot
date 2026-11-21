-- Owner-only runs never enter the automatic queue, including after a crash.
ALTER TABLE memory_organizations ADD COLUMN owner_initiated INTEGER NOT NULL DEFAULT 0
  CHECK(owner_initiated IN (0,1));

-- A pending destination is not yet a copy: keep the dependency until confirmation and undo.
CREATE TABLE memory_scope_moves (
  removal_id TEXT PRIMARY KEY REFERENCES scoped_memory_proposals(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  target_bot_id TEXT NOT NULL,
  target_proposal_id TEXT,
  target_memory_id TEXT,
  source_json TEXT NOT NULL,
  copy_json TEXT NOT NULL,
  target_before_json TEXT
);
CREATE INDEX memory_scope_moves_target ON memory_scope_moves(target_proposal_id);
