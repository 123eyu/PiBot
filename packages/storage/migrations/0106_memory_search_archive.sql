-- pibot:step memory-search
ALTER TABLE scoped_memories ADD COLUMN archived_at TEXT;
ALTER TABLE scoped_memories ADD COLUMN last_used_at TEXT;
ALTER TABLE scoped_memories ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count>=0);
ALTER TABLE scoped_memories ADD COLUMN normalized_text TEXT NOT NULL DEFAULT '';
CREATE INDEX scoped_memory_duplicate ON scoped_memories(scope,owner_id,normalized_text);
CREATE INDEX scoped_memory_activity ON scoped_memories(scope,owner_id,archived_at,last_used_at,created_at,id);
CREATE VIRTUAL TABLE memory_fts USING fts5(text,content='scoped_memories',content_rowid='rowid',tokenize='trigram');
CREATE TRIGGER memory_fts_insert AFTER INSERT ON scoped_memories BEGIN
 INSERT INTO memory_fts(rowid,text) VALUES(NEW.rowid,NEW.text);
END;
CREATE TRIGGER memory_fts_delete AFTER DELETE ON scoped_memories BEGIN
 INSERT INTO memory_fts(memory_fts,rowid,text) VALUES('delete',OLD.rowid,OLD.text);
END;
CREATE TRIGGER memory_fts_update AFTER UPDATE OF text ON scoped_memories BEGIN
 INSERT INTO memory_fts(memory_fts,rowid,text) VALUES('delete',OLD.rowid,OLD.text);
 INSERT INTO memory_fts(rowid,text) VALUES(NEW.rowid,NEW.text);
END;
INSERT INTO memory_fts(memory_fts) VALUES('rebuild');
DROP TRIGGER scoped_memory_quota_insert;
DROP TRIGGER scoped_memory_quota_update;
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
