-- pibot:rebuild-referenced-tables
-- ACP roots belong to the ACP-created topic, but must not become a Bot's user folder.
DROP VIEW IF EXISTS unattended_definition_folders;
DROP VIEW IF EXISTS unattended_watched_paths;

CREATE TABLE working_folders_acp (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id),
  path TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  association TEXT NOT NULL DEFAULT 'user' CHECK(association IN ('user','monitor','session')),
  last_used_at TEXT, hidden_at TEXT, location TEXT NOT NULL DEFAULT 'local',
  UNIQUE(bot_id, path), UNIQUE(bot_id, id)
);
INSERT INTO working_folders_acp
  (id,bot_id,path,name,position,created_at,association,last_used_at,hidden_at,location)
SELECT id,bot_id,path,name,position,created_at,association,last_used_at,hidden_at,location
FROM working_folders;
DROP TABLE working_folders;
ALTER TABLE working_folders_acp RENAME TO working_folders;
CREATE INDEX working_folders_bot_position ON working_folders(bot_id, position);

CREATE VIEW unattended_definition_folders AS
  SELECT r.id AS definition_id, r.bot_id, json_extract(r.workplace,'$.folderId') AS folder_id,
    'primary' AS role
  FROM routines r WHERE r.deleted_at IS NULL AND json_valid(r.workplace)
    AND json_extract(r.workplace,'$.folderId') IS NOT NULL
  UNION ALL
  SELECT r.id, r.bot_id, json_extract(r.workplace,'$.cwd'), 'cwd'
  FROM routines r WHERE r.deleted_at IS NULL AND json_valid(r.workplace)
    AND json_extract(r.workplace,'$.cwd') IS NOT NULL
  UNION ALL
  SELECT r.id, r.bot_id, j.value, 'readonly'
  FROM routines r, json_each(r.workplace,'$.readonly') j
  WHERE r.deleted_at IS NULL AND json_valid(r.workplace)
  UNION ALL
  SELECT r.id, r.bot_id, f.id, 'watched'
  FROM routines r
  JOIN routine_triggers tr ON tr.routine_id=r.id AND tr.deleted_at IS NULL AND tr.kind='folder'
  JOIN working_folders f ON f.bot_id=r.bot_id AND f.path=json_extract(tr.config,'$.path')
  WHERE r.deleted_at IS NULL AND json_valid(r.workplace);

CREATE VIEW unattended_watched_paths AS
  SELECT json_extract(t.config,'$.path') AS path
  FROM routine_triggers t JOIN routines r ON r.id=t.routine_id
  WHERE t.deleted_at IS NULL AND r.deleted_at IS NULL AND t.kind='folder';
