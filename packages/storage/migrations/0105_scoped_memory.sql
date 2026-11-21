-- pibot:step scoped-memory
CREATE TABLE scoped_memories (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('user','bot','group')),
 owner_id TEXT NOT NULL, bot_id TEXT NOT NULL,
 text TEXT NOT NULL CHECK(length(trim(text))>0 AND length(text)<=8000 AND instr(text,char(0))=0),
 category TEXT CHECK(category IN ('about_you','work','how_to')),
 source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
 sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((scope='user' AND owner_id='user') OR (scope<>'user' AND owner_id<>'user'))
);
CREATE INDEX scoped_memories_owner ON scoped_memories(scope,owner_id,created_at,id);
CREATE TABLE memory_aliases (
 id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES scoped_memories(id) ON DELETE CASCADE
);
CREATE TABLE scoped_memory_proposals (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('user','bot','group')),
 owner_id TEXT NOT NULL, bot_id TEXT NOT NULL, text TEXT NOT NULL,
 category TEXT CHECK(category IN ('about_you','work','how_to')),
 message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
 action TEXT NOT NULL CHECK(action IN ('add','update','remove')), memory_id TEXT,
 resolved_memory_id TEXT REFERENCES scoped_memories(id) ON DELETE SET NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
 created_at TEXT NOT NULL, before_json TEXT,
 CHECK((scope='user' AND owner_id='user') OR (scope<>'user' AND owner_id<>'user'))
);
CREATE INDEX scoped_memory_pending ON scoped_memory_proposals(scope,owner_id,status,created_at,id);
CREATE INDEX scoped_memory_author ON scoped_memory_proposals(bot_id,status,created_at,id);
CREATE TRIGGER scoped_memory_bot_cleanup AFTER DELETE ON bots BEGIN
 DELETE FROM scoped_memory_proposals WHERE scope='bot' AND owner_id=OLD.id;
 DELETE FROM scoped_memories WHERE scope='bot' AND owner_id=OLD.id;
END;
CREATE TRIGGER scoped_memory_group_cleanup AFTER DELETE ON groups BEGIN
 DELETE FROM scoped_memory_proposals WHERE scope='group' AND owner_id=OLD.id;
 DELETE FROM scoped_memories WHERE scope='group' AND owner_id=OLD.id;
END;
