-- FTS never reads the original messages table as external content.
CREATE TABLE chat_search_documents (
  -- An explicit rowid alias keeps FTS references stable across VACUUM.
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  body TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX chat_search_short_scope ON chat_search_documents(scope, created_at DESC, message_id DESC)
  WHERE body IS NOT NULL AND body<>'';
CREATE INDEX chat_search_pending ON chat_search_documents(message_id) WHERE body IS NULL;
CREATE VIRTUAL TABLE chat_search_fts USING fts5(
  scope, body, content='chat_search_documents', content_rowid='rowid', tokenize='trigram'
);
INSERT INTO chat_search_fts(chat_search_fts,rank) VALUES('secure-delete',1);

CREATE TRIGGER chat_search_fts_insert AFTER INSERT ON chat_search_documents WHEN NEW.body<>'' BEGIN
  INSERT INTO chat_search_fts(rowid,scope,body) VALUES(NEW.rowid,NEW.scope,NEW.body);
END;
CREATE TRIGGER chat_search_fts_delete AFTER DELETE ON chat_search_documents WHEN OLD.body<>'' BEGIN
  INSERT INTO chat_search_fts(chat_search_fts,rowid,scope,body)
    VALUES('delete',OLD.rowid,OLD.scope,OLD.body);
END;
CREATE TRIGGER chat_search_fts_update AFTER UPDATE OF scope,body ON chat_search_documents
WHEN OLD.scope IS NOT NEW.scope OR OLD.body IS NOT NEW.body BEGIN
  INSERT INTO chat_search_fts(chat_search_fts,rowid,scope,body)
    SELECT 'delete',OLD.rowid,OLD.scope,OLD.body WHERE OLD.body<>'';
  INSERT INTO chat_search_fts(rowid,scope,body)
    SELECT NEW.rowid,NEW.scope,NEW.body WHERE NEW.body<>'';
END;

-- The high-water mark is an indexed seek, not a migration-time scan. Message IDs survive VACUUM.
CREATE TABLE chat_search_backfill (
  id INTEGER PRIMARY KEY CHECK(id=1),
  after_id TEXT NOT NULL,
  through_id TEXT NOT NULL
);
INSERT INTO chat_search_backfill VALUES(1,'',COALESCE((SELECT MAX(id) FROM messages),''));

-- Synthetic inputs, tool results, attachments and internal task threads are not conversation prose.
CREATE VIEW chat_search_source AS
  SELECT m.id,
    CASE WHEN m.role='user' AND json_type(m.usage,'$.forward')='object'
      THEN CASE WHEN json_type(m.usage,'$.forward.note')='text'
        THEN json_extract(m.usage,'$.forward.note') ELSE '' END
      ELSE m.content END AS content,
    c.kind||':'||COALESCE(c.bot_id,c.group_id) AS scope, m.created_at
  FROM messages m JOIN conversations c ON c.id=m.conversation_id
  WHERE m.status='done' AND m.role IN ('user','assistant') AND m.content<>''
    AND m.routine_trigger IS NULL AND json_extract(m.usage,'$.systemEvent') IS NOT 1
    AND c.internal_task_id IS NULL AND c.kind IN ('dm','group')
    AND (c.kind<>'dm' OR m.role='user' OR m.bot_id=c.bot_id);

CREATE TRIGGER chat_search_message_insert AFTER INSERT ON messages BEGIN
  INSERT INTO chat_search_documents(message_id,scope,body,created_at)
    SELECT id,scope,pibot_chat_search_redact(content),created_at FROM chat_search_source WHERE id=NEW.id;
END;
CREATE TRIGGER chat_search_message_update
AFTER UPDATE OF content,status,role,bot_id,conversation_id,usage,routine_trigger,created_at ON messages
WHEN OLD.content IS NOT NEW.content OR OLD.status IS NOT NEW.status
  OR OLD.created_at IS NOT NEW.created_at OR OLD.role IS NOT NEW.role OR OLD.bot_id IS NOT NEW.bot_id
  OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.routine_trigger IS NOT NEW.routine_trigger
  OR json_extract(OLD.usage,'$.systemEvent') IS NOT json_extract(NEW.usage,'$.systemEvent')
  OR json_type(OLD.usage,'$.forward') IS NOT json_type(NEW.usage,'$.forward')
  OR json_extract(OLD.usage,'$.forward.note') IS NOT json_extract(NEW.usage,'$.forward.note')
BEGIN
  DELETE FROM chat_search_documents WHERE message_id=OLD.id;
  INSERT INTO chat_search_documents(message_id,scope,body,created_at)
    SELECT id,scope,pibot_chat_search_redact(content),created_at FROM chat_search_source WHERE id=NEW.id;
END;
