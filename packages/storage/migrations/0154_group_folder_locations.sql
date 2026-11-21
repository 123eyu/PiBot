-- pibot:rebuild-referenced-tables
-- A path is meaningful only on its device; preserve IDs used by workspace foreign keys.
CREATE TABLE group_folders_locations (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'local',
  UNIQUE(group_id,location,path)
);
INSERT INTO group_folders_locations(id,group_id,path,position,created_at)
  SELECT id,group_id,path,position,created_at FROM group_folders;
DROP TABLE group_folders;
ALTER TABLE group_folders_locations RENAME TO group_folders;
CREATE INDEX group_folders_order ON group_folders(group_id,position,id);
CREATE UNIQUE INDEX group_folders_owner_id ON group_folders(group_id,id);
