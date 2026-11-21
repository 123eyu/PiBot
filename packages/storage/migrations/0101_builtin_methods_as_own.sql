-- A built-in method is one of the Bot's (or group member's) own skills. The row keeps
-- the version it was installed or last updated from (builtin_digest / builtin_version), whether
-- the user changed it since, the version the user chose to keep ("保留我的") and the version it
-- was auto-updated to until the user has looked at it.
ALTER TABLE skills ADD COLUMN builtin_version INTEGER;
ALTER TABLE skills ADD COLUMN builtin_modified INTEGER NOT NULL DEFAULT 0
  CHECK(builtin_modified IN (0,1));
ALTER TABLE skills ADD COLUMN builtin_kept_version INTEGER;
ALTER TABLE skills ADD COLUMN builtin_updated_version INTEGER;
ALTER TABLE skills ADD COLUMN archived_at TEXT;
ALTER TABLE skills ADD COLUMN builtin_merge_pending INTEGER NOT NULL DEFAULT 0
  CHECK(builtin_merge_pending IN (0,1));
ALTER TABLE group_member_skills ADD COLUMN builtin_version INTEGER;
ALTER TABLE group_member_skills ADD COLUMN builtin_modified INTEGER NOT NULL DEFAULT 0
  CHECK(builtin_modified IN (0,1));
ALTER TABLE group_member_skills ADD COLUMN builtin_kept_version INTEGER;
ALTER TABLE group_member_skills ADD COLUMN builtin_updated_version INTEGER;
ALTER TABLE group_member_skills ADD COLUMN archived_at TEXT;
ALTER TABLE group_member_skills ADD COLUMN builtin_merge_pending INTEGER NOT NULL DEFAULT 0
  CHECK(builtin_merge_pending IN (0,1));

-- An archived duplicate keeps its row and folder but no longer holds its name, so the one
-- remaining copy of a method can carry the method's own name (no 「周期简报 2」).
DROP INDEX IF EXISTS skills_bot_name;
CREATE UNIQUE INDEX skills_bot_name ON skills(bot_id,name COLLATE NOCASE) WHERE archived_at IS NULL;
DROP INDEX IF EXISTS group_skills_name;
CREATE UNIQUE INDEX group_skills_name ON group_member_skills(group_id,bot_id,name COLLATE NOCASE)
  WHERE archived_at IS NULL;

-- A deleted built-in method is not installed again until the user restores it. scope '' is the
-- Bot's own skills, otherwise the group id.
CREATE TABLE IF NOT EXISTS builtin_skill_removals (
  scope TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  builtin_key TEXT NOT NULL CHECK(builtin_key GLOB '[a-z0-9]*' AND length(builtin_key) <= 64),
  removed_at TEXT NOT NULL,
  PRIMARY KEY(scope, bot_id, builtin_key)
);

-- Installed each method next to the older team-template copy of the same method (and
-- 「复制为我的」 made more copies), so one method could exist two or three times. Which rows are
-- the same method can only be decided from their files (the built-in history fingerprints), so
-- the rows that may be part of such a set are queued here; the brain's built-in sync merges each
-- set once, row by row: an unreadable or ambiguous row is left as it is, every merged or archived
-- row is audited, and a surplus row is disabled and archived, never deleted.
UPDATE skills SET builtin_merge_pending=1
WHERE archived_at IS NULL AND (builtin_key IS NOT NULL OR source IN ('team','taught'));
UPDATE group_member_skills SET builtin_merge_pending=1
WHERE archived_at IS NULL AND (builtin_key IS NOT NULL OR source IN ('team','taught'));
CREATE INDEX IF NOT EXISTS skills_builtin_merge ON skills(bot_id) WHERE builtin_merge_pending=1;
CREATE INDEX IF NOT EXISTS group_skills_builtin_merge
  ON group_member_skills(group_id,bot_id) WHERE builtin_merge_pending=1;
