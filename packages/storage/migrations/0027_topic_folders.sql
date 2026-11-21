-- Folders belong to conversations, not to the Bot. Each DM topic keeps its own
-- primary folder (conversations.workplace_folder_id, `home` = the Bot's own folder) plus read-only
-- references (topic_folders); routines keep theirs in routines.workplace; groups keep their
-- group_folders. working_folders stays as the Bot's "used folders": last_used_at orders the list,
-- hidden_at is "remove record" (the row stays so topics and routines that use it keep working).
--
-- The conversion keeps every topic's and routine's writable root, read-only roots and working
-- directory exactly as they were (the Bot's current folder writable, all its other folders
-- read-only); no folder becomes writable that was not. Every write is guarded (IS NULL /
-- NOT EXISTS), so the statements are safe to apply again.

ALTER TABLE working_folders ADD COLUMN last_used_at TEXT;
ALTER TABLE working_folders ADD COLUMN hidden_at TEXT;

CREATE TABLE IF NOT EXISTS topic_folders (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(conversation_id, folder_id),
  FOREIGN KEY(bot_id, folder_id) REFERENCES working_folders(bot_id, id)
);
-- "In which topics is this folder used" for the Bot details list.
CREATE INDEX IF NOT EXISTS topic_folders_folder ON topic_folders(bot_id, folder_id);
CREATE INDEX IF NOT EXISTS conversations_dm_folder ON conversations(bot_id, workplace_folder_id) WHERE kind='dm';

-- ① Topics that followed the Bot are bound to the Bot's current folder (home stays home).
UPDATE conversations
SET workplace_folder_id=COALESCE((SELECT w.current_folder_id FROM bot_workplace w WHERE w.bot_id=conversations.bot_id),'home')
WHERE kind='dm' AND workplace_folder_id IS NULL AND bot_id IS NOT NULL;

-- ② Every other folder of the Bot (monitor associations included) was a read-only root of every
-- run; keep exactly that set on every topic. Nothing becomes writable that was not.
INSERT OR IGNORE INTO topic_folders(conversation_id,bot_id,folder_id,position)
SELECT id,bot_id,folder_id,n FROM (
  SELECT c.id,c.bot_id,f.id AS folder_id,
    ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY f.position,f.id) AS n
  FROM conversations c JOIN working_folders f ON f.bot_id=c.bot_id
  WHERE c.kind='dm' AND f.id IS NOT c.workplace_folder_id
    AND NOT EXISTS (SELECT 1 FROM topic_folders t WHERE t.conversation_id=c.id)
) WHERE n<=32;

-- ③ Routines ran with the Bot's current folder as the only writable root, whatever folder they
-- had chosen: that choice only moved the working directory.
-- So the primary is the old current folder (home stays home), every other folder stays a
-- read-only reference, and a chosen folder that was not the primary is kept as `cwd`.
DROP TABLE IF EXISTS temp.t21_routine_primary;
DROP TABLE IF EXISTS temp.t21_routine_refs;
CREATE TEMP TABLE t21_routine_primary AS
SELECT r.id,r.bot_id,
  COALESCE((SELECT w.current_folder_id FROM bot_workplace w WHERE w.bot_id=r.bot_id),'home') AS primary_id,
  CASE WHEN json_extract(r.workplace,'$.kind')='folder' THEN json_extract(r.workplace,'$.folderId') END AS chosen
FROM routines r WHERE json_valid(r.workplace) AND json_type(r.workplace,'$.readonly') IS NULL;
CREATE TEMP TABLE t21_routine_refs AS
SELECT p.id AS routine_id,f.id AS folder_id,
  ROW_NUMBER() OVER (PARTITION BY p.id ORDER BY f.position,f.id) AS n
FROM t21_routine_primary p JOIN working_folders f ON f.bot_id=p.bot_id
WHERE f.id IS NOT p.primary_id
ORDER BY p.id,n;
UPDATE routines SET workplace=json_object(
  'kind','folder',
  'folderId',(SELECT p.primary_id FROM t21_routine_primary p WHERE p.id=routines.id),
  'readonly',json(COALESCE((SELECT json_group_array(r.folder_id) FROM t21_routine_refs r WHERE r.routine_id=routines.id AND r.n<=32),'[]')))
WHERE id IN (SELECT id FROM t21_routine_primary);
UPDATE routines SET workplace=json_set(workplace,'$.cwd',(SELECT p.chosen FROM t21_routine_primary p WHERE p.id=routines.id))
WHERE id IN (SELECT id FROM t21_routine_primary WHERE chosen IS NOT NULL AND chosen IS NOT primary_id);
DROP TABLE temp.t21_routine_refs;
DROP TABLE temp.t21_routine_primary;

-- ④ Groups without folders of their own used their owner's boundary (the coordinator, or the Bot
-- of a legacy GroupWorkplace.folder): its current folder writable, its other folders read-only.
-- Copy that in as the group's own folders. A group whose owner worked in its home keeps no
-- folders (the coordinator's home, as before) except a legacy chosen folder, kept read-only.
-- Known narrowing: the group model has no separate working directory, so a legacy chosen folder
-- that was only the cwd now is a read-only folder and commands start in the primary.
DROP TABLE IF EXISTS temp.t21_group_owner;
DROP TABLE IF EXISTS temp.t21_group_folder;
CREATE TEMP TABLE t21_group_owner AS
SELECT g.id AS group_id,
  CASE WHEN json_extract(g.workplace,'$.kind')='folder' THEN json_extract(g.workplace,'$.botId') ELSE g.coordinator_bot_id END AS owner,
  CASE WHEN json_extract(g.workplace,'$.kind')='folder' THEN json_extract(g.workplace,'$.folderId') END AS chosen
FROM groups g WHERE NOT EXISTS (SELECT 1 FROM group_folders gf WHERE gf.group_id=g.id);
CREATE TEMP TABLE t21_group_folder AS
SELECT o.group_id,f.path,'primary' AS role,0 AS position,
  lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||
  substr('89ab',1+(abs(random())%4),1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))) AS new_id
FROM t21_group_owner o JOIN bot_workplace w ON w.bot_id=o.owner JOIN working_folders f ON f.bot_id=o.owner AND f.id=w.current_folder_id
UNION ALL
SELECT group_id,path,'readonly',n,
  lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||
  substr('89ab',1+(abs(random())%4),1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)))
FROM (
  SELECT o.group_id,f.path,ROW_NUMBER() OVER (PARTITION BY o.group_id ORDER BY f.position,f.id) AS n
  FROM t21_group_owner o JOIN working_folders f ON f.bot_id=o.owner LEFT JOIN bot_workplace w ON w.bot_id=o.owner
  WHERE f.id IS NOT w.current_folder_id AND (w.current_folder_id IS NOT NULL OR f.id=o.chosen)
) WHERE n<=31;
INSERT INTO group_folders(id,group_id,path,position,created_at)
SELECT new_id,group_id,path,position,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM t21_group_folder;
INSERT INTO group_workspace(group_id,primary_folder_id,primary_initialized,revision)
SELECT DISTINCT group_id,(SELECT p.new_id FROM t21_group_folder p WHERE p.group_id=t.group_id AND p.role='primary'),1,1
FROM t21_group_folder t WHERE true
ON CONFLICT(group_id) DO UPDATE SET primary_folder_id=excluded.primary_folder_id,primary_initialized=1,revision=revision+1;
DROP TABLE temp.t21_group_folder;
DROP TABLE temp.t21_group_owner;

-- ⑤ "Recently used": the latest topic that works in the folder, else when it was added.
UPDATE working_folders SET last_used_at=COALESCE(
  (SELECT MAX(c.updated_at) FROM conversations c WHERE c.kind='dm' AND c.bot_id=working_folders.bot_id AND c.workplace_folder_id=working_folders.id),
  created_at)
WHERE last_used_at IS NULL;
