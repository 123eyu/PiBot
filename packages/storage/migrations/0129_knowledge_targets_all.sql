-- Knowledge access can be shared with every current and future Bot/group.
-- Existing rows remain selected because the default is false and their assignment rows stay intact.
ALTER TABLE knowledge_sources
  ADD COLUMN targets_all INTEGER NOT NULL DEFAULT 0 CHECK (targets_all IN (0, 1));
