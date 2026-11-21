-- Append the explanation record kind without changing existing notice facts.
CREATE TABLE chat_notices_v5 (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('browser_handback', 'auto_check', 'auto_check_proposal',
    'computer_handoff', 'continuation_stopped', 'connection_needed')),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO chat_notices_v5 (id, conversation_id, bot_id, kind, detail, created_at)
  SELECT id, conversation_id, bot_id, kind, detail, created_at FROM chat_notices;
DROP TABLE chat_notices;
ALTER TABLE chat_notices_v5 RENAME TO chat_notices;
CREATE INDEX IF NOT EXISTS chat_notices_conversation ON chat_notices(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS chat_notices_bot ON chat_notices(bot_id);
CREATE INDEX IF NOT EXISTS chat_notices_kind ON chat_notices(kind, created_at);

CREATE UNIQUE INDEX chat_notices_connection_run ON chat_notices(json_extract(detail, '$.runId'), json_extract(detail, '$.availability.connection')) WHERE kind='connection_needed';
CREATE INDEX grants_connector_tool ON grants(json_extract(scope, '$.connectorId'), created_at, id) WHERE revoked_at IS NULL AND json_extract(scope, '$.kind')='connector_tool';
