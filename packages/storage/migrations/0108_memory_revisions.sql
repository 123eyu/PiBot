-- Historical edits cannot be reconstructed; retain the current version as an explicit baseline.
CREATE TABLE memory_revisions (
 version INTEGER PRIMARY KEY AUTOINCREMENT,
 memory_id TEXT NOT NULL REFERENCES scoped_memories(id) ON DELETE CASCADE,
 text TEXT NOT NULL, category TEXT, archived_at TEXT,
 changed_at TEXT NOT NULL, baseline INTEGER NOT NULL CHECK(baseline IN (0,1))
);
CREATE INDEX memory_revisions_page ON memory_revisions(memory_id,version);
INSERT INTO memory_revisions(memory_id,text,category,archived_at,changed_at,baseline)
 SELECT id,text,category,archived_at,updated_at,1 FROM scoped_memories;
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
