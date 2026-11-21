-- Copies outlive the source connection and the user may delete a copy without resurrecting it.
CREATE TABLE IF NOT EXISTS plugin_skill_copies (
  installation_id TEXT NOT NULL,
  skill_path TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('bot','group')),
  target_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,skill_path,target_kind,target_id,bot_id)
);
CREATE TABLE IF NOT EXISTS plugin_skill_copy_jobs (
  installation_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('bot','group')),
  target_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','failed')),
  PRIMARY KEY(installation_id,target_kind,target_id,bot_id)
);
CREATE TABLE IF NOT EXISTS plugin_skill_copy_migrations (
  installation_id TEXT PRIMARY KEY,
  mode TEXT,
  bots_json TEXT,
  groups_json TEXT,
  targets_frozen INTEGER NOT NULL DEFAULT 0 CHECK(targets_frozen IN (0,1)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','failed'))
);
INSERT OR IGNORE INTO plugin_skill_copy_migrations(installation_id,mode,bots_json,groups_json)
SELECT p.id,a.mode,a.bots_json,a.groups_json FROM plugin_installations p
LEFT JOIN plugin_skill_access a ON a.installation_id=p.id
WHERE p.source_kind='directory' AND p.status='installed';
-- Freeze CURRENT skill permissions, never connection access or its migration snapshot.
-- First-read approval changes ask_first to selected/all atomically. An ask_first row has no
-- durable current consent and therefore grants no copy; historical audit is not permission.
INSERT OR IGNORE INTO plugin_skill_copy_jobs(installation_id,target_kind,target_id,bot_id)
SELECT p.id,'bot',b.id,b.id FROM plugin_installations p
JOIN plugin_skill_copy_migrations a ON a.installation_id=p.id JOIN bots b
WHERE p.source_kind='directory' AND p.status='installed' AND a.mode='all' AND a.targets_frozen=0;
INSERT OR IGNORE INTO plugin_skill_copy_jobs(installation_id,target_kind,target_id,bot_id)
SELECT p.id,'bot',j.value,j.value FROM plugin_installations p
JOIN plugin_skill_copy_migrations a ON a.installation_id=p.id
JOIN json_each(CASE WHEN json_valid(a.bots_json) THEN CASE WHEN json_type(a.bots_json)='array' THEN a.bots_json ELSE '[]' END ELSE '[]' END) j
WHERE p.source_kind='directory' AND p.status='installed' AND a.mode='selected' AND j.type='text' AND a.targets_frozen=0;
INSERT OR IGNORE INTO plugin_skill_copy_jobs(installation_id,target_kind,target_id,bot_id)
SELECT p.id,'group',j.value,COALESCE(m.bot_id,'') FROM plugin_installations p
JOIN plugin_skill_copy_migrations a ON a.installation_id=p.id
JOIN json_each(CASE WHEN json_valid(a.groups_json) THEN CASE WHEN json_type(a.groups_json)='array' THEN a.groups_json ELSE '[]' END ELSE '[]' END) j
LEFT JOIN group_members m ON m.group_id=j.value AND m.left_at IS NULL
WHERE p.source_kind='directory' AND p.status='installed' AND a.mode='selected' AND j.type='text' AND a.targets_frozen=0;

UPDATE plugin_skill_copy_migrations SET targets_frozen=1 WHERE targets_frozen=0;
