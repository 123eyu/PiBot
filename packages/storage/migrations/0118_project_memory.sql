-- pibot:rebuild-referenced-tables
-- Project memory moves from AGENTS.md into Pi Bot. A project is one canonical working
-- folder path shared by every Bot and group; scoped tables gain the 'project' scope. Rows keep
-- their rowid because memory_fts is an external-content index keyed by it.
CREATE TABLE memory_projects (
 id TEXT PRIMARY KEY,
 path TEXT NOT NULL UNIQUE CHECK(length(path)>0 AND length(path)<=4096 AND instr(path,char(0))=0),
 created_at TEXT NOT NULL
);

-- Triggers on other tables name these tables; drop them so the rename below can re-parse cleanly.
DROP TRIGGER scoped_memory_bot_cleanup;
DROP TRIGGER scoped_memory_group_cleanup;

CREATE TABLE scoped_memories_next (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('user','bot','group','project')),
 owner_id TEXT NOT NULL, bot_id TEXT NOT NULL,
 text TEXT NOT NULL CHECK(length(trim(text))>0 AND length(text)<=8000 AND instr(text,char(0))=0),
 category TEXT CHECK(category IN ('about_you','work','how_to')),
 source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
 sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count>=0), normalized_text TEXT NOT NULL DEFAULT '',
 CHECK((scope='user' AND owner_id='user') OR (scope<>'user' AND owner_id<>'user'))
);
INSERT INTO scoped_memories_next(rowid,id,scope,owner_id,bot_id,text,category,source_message_id,sources_json,created_at,updated_at,archived_at,last_used_at,use_count,normalized_text)
SELECT rowid,id,scope,owner_id,bot_id,text,category,source_message_id,sources_json,created_at,updated_at,archived_at,last_used_at,use_count,normalized_text FROM scoped_memories;

CREATE TABLE scoped_memory_proposals_next (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('user','bot','group','project')),
 owner_id TEXT NOT NULL, bot_id TEXT NOT NULL, text TEXT NOT NULL,
 category TEXT CHECK(category IN ('about_you','work','how_to')),
 message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
 action TEXT NOT NULL CHECK(action IN ('add','update','remove')), memory_id TEXT,
 resolved_memory_id TEXT REFERENCES scoped_memories(id) ON DELETE SET NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
 created_at TEXT NOT NULL, before_json TEXT,
 CHECK((scope='user' AND owner_id='user') OR (scope<>'user' AND owner_id<>'user'))
);
INSERT INTO scoped_memory_proposals_next(rowid,id,scope,owner_id,bot_id,text,category,message_id,action,memory_id,resolved_memory_id,status,created_at,before_json)
SELECT rowid,id,scope,owner_id,bot_id,text,category,message_id,action,memory_id,resolved_memory_id,status,created_at,before_json FROM scoped_memory_proposals;

DROP TABLE scoped_memory_proposals;
DROP TABLE scoped_memories;
ALTER TABLE scoped_memories_next RENAME TO scoped_memories;
ALTER TABLE scoped_memory_proposals_next RENAME TO scoped_memory_proposals;

CREATE INDEX scoped_memories_owner ON scoped_memories(scope,owner_id,created_at,id);
CREATE INDEX scoped_memory_activity ON scoped_memories(scope,owner_id,archived_at,last_used_at,created_at,id);
CREATE INDEX scoped_memory_duplicate ON scoped_memories(scope,owner_id,normalized_text);
CREATE INDEX scoped_memory_author ON scoped_memory_proposals(bot_id,status,created_at,id);
CREATE INDEX scoped_memory_pending ON scoped_memory_proposals(scope,owner_id,status,created_at,id);

CREATE TRIGGER memory_fts_delete AFTER DELETE ON scoped_memories BEGIN
 INSERT INTO memory_fts(memory_fts,rowid,normalized_text) VALUES('delete',OLD.rowid,OLD.normalized_text);
END;
CREATE TRIGGER memory_fts_insert AFTER INSERT ON scoped_memories BEGIN
 INSERT INTO memory_fts(rowid,normalized_text) VALUES(NEW.rowid,NEW.normalized_text);
END;
CREATE TRIGGER memory_fts_update AFTER UPDATE OF normalized_text ON scoped_memories BEGIN
 INSERT INTO memory_fts(memory_fts,rowid,normalized_text) VALUES('delete',OLD.rowid,OLD.normalized_text);
 INSERT INTO memory_fts(rowid,normalized_text) VALUES(NEW.rowid,NEW.normalized_text);
END;
CREATE TRIGGER memory_revision_insert AFTER INSERT ON scoped_memories BEGIN
 INSERT INTO memory_revisions(memory_id,text,category,archived_at,changed_at,baseline)
 VALUES(NEW.id,NEW.text,NEW.category,NEW.archived_at,NEW.updated_at,0);
END;
CREATE TRIGGER memory_revision_update AFTER UPDATE OF text,category,archived_at ON scoped_memories
WHEN OLD.text IS NOT NEW.text OR OLD.category IS NOT NEW.category OR OLD.archived_at IS NOT NEW.archived_at
BEGIN
 INSERT INTO memory_revisions(memory_id,text,category,archived_at,changed_at,baseline)
 VALUES(NEW.id,NEW.text,NEW.category,NEW.archived_at,NEW.updated_at,0);
END;
CREATE TRIGGER scoped_memory_quota_insert BEFORE INSERT ON scoped_memories
WHEN NEW.archived_at IS NULL AND (
 (SELECT COUNT(*) FROM scoped_memories WHERE scope=NEW.scope AND owner_id=NEW.owner_id AND archived_at IS NULL)>=100 OR
 (SELECT COALESCE(SUM(length(text)),0) FROM scoped_memories WHERE scope=NEW.scope AND owner_id=NEW.owner_id AND archived_at IS NULL)+length(NEW.text)>8000)
BEGIN SELECT RAISE(ABORT,'Memory quota exceeded'); END;
CREATE TRIGGER scoped_memory_quota_update BEFORE UPDATE OF text,scope,owner_id,archived_at ON scoped_memories
WHEN NEW.archived_at IS NULL AND (OLD.archived_at IS NOT NULL OR NEW.scope<>OLD.scope OR NEW.owner_id<>OLD.owner_id OR length(NEW.text)>length(OLD.text)) AND (
 (SELECT COUNT(*) FROM scoped_memories WHERE scope=NEW.scope AND owner_id=NEW.owner_id AND archived_at IS NULL AND id<>OLD.id)>=100 OR
 (SELECT COALESCE(SUM(length(text)),0) FROM scoped_memories WHERE scope=NEW.scope AND owner_id=NEW.owner_id AND archived_at IS NULL AND id<>OLD.id)+length(NEW.text)>8000)
BEGIN SELECT RAISE(ABORT,'Memory quota exceeded'); END;
CREATE TRIGGER scoped_memory_bot_cleanup AFTER DELETE ON bots BEGIN
 DELETE FROM scoped_memory_proposals WHERE scope='bot' AND owner_id=OLD.id;
 DELETE FROM scoped_memories WHERE scope='bot' AND owner_id=OLD.id;
END;
CREATE TRIGGER scoped_memory_group_cleanup AFTER DELETE ON groups BEGIN
 DELETE FROM scoped_memory_proposals WHERE scope='group' AND owner_id=OLD.id;
 DELETE FROM scoped_memories WHERE scope='group' AND owner_id=OLD.id;
END;
