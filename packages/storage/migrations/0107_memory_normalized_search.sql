-- pibot:step memory-search
-- Keep the external-content column identical to the normalized query representation.
DROP TRIGGER memory_fts_insert;
DROP TRIGGER memory_fts_delete;
DROP TRIGGER memory_fts_update;
DROP TABLE memory_fts;
CREATE VIRTUAL TABLE memory_fts USING fts5(normalized_text,content='scoped_memories',content_rowid='rowid',tokenize='trigram');
INSERT INTO memory_fts(memory_fts) VALUES('rebuild');
CREATE TRIGGER memory_fts_insert AFTER INSERT ON scoped_memories BEGIN
 INSERT INTO memory_fts(rowid,normalized_text) VALUES(NEW.rowid,NEW.normalized_text);
END;
CREATE TRIGGER memory_fts_delete AFTER DELETE ON scoped_memories BEGIN
 INSERT INTO memory_fts(memory_fts,rowid,normalized_text) VALUES('delete',OLD.rowid,OLD.normalized_text);
END;
CREATE TRIGGER memory_fts_update AFTER UPDATE OF normalized_text ON scoped_memories BEGIN
 INSERT INTO memory_fts(memory_fts,rowid,normalized_text) VALUES('delete',OLD.rowid,OLD.normalized_text);
 INSERT INTO memory_fts(rowid,normalized_text) VALUES(NEW.rowid,NEW.normalized_text);
END;
