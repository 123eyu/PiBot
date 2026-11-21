-- Group resources are separate from Bot resources: no DM rows are rewritten or inherited.
CREATE TABLE IF NOT EXISTS group_memories (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, text TEXT NOT NULL,
 category TEXT CHECK(category IN ('about_you','work','how_to') OR category IS NULL),
 source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS group_memories_owner ON group_memories(group_id,created_at,id);
CREATE TABLE IF NOT EXISTS group_memory_proposals (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, text TEXT NOT NULL,
 category TEXT CHECK(category IN ('about_you','work','how_to') OR category IS NULL),
 message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
 action TEXT NOT NULL CHECK(action IN ('add','update','remove')), memory_id TEXT,
 resolved_memory_id TEXT, status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
 created_at TEXT NOT NULL, before_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS group_memory_pending ON group_memory_proposals(group_id,status,created_at,id);
CREATE TABLE IF NOT EXISTS group_member_skills (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
 bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 name TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), path TEXT NOT NULL,
 last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS group_skills_name ON group_member_skills(group_id,bot_id,name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS group_skills_path ON group_member_skills(group_id,bot_id,path);
CREATE INDEX IF NOT EXISTS group_skills_owner ON group_member_skills(group_id,bot_id,created_at,id);
