ALTER TABLE groups ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS groups_archived ON groups(archived_at,id);
