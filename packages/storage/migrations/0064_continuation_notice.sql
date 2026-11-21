-- A centered "automatic follow-up stopped" line in the topic. Chat records gain the kind.
-- SQLite cannot widen a CHECK constraint in place; nothing references chat_notices, so the table
-- is copied over (as in 0033 and 0036). The runner applies a version once, in one transaction.
CREATE TABLE chat_notices_v4 (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('browser_handback', 'auto_check', 'auto_check_proposal',
    'computer_handoff', 'continuation_stopped')),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO chat_notices_v4 (id, conversation_id, bot_id, kind, detail, created_at)
  SELECT id, conversation_id, bot_id, kind, detail, created_at FROM chat_notices;
DROP TABLE chat_notices;
ALTER TABLE chat_notices_v4 RENAME TO chat_notices;
CREATE INDEX IF NOT EXISTS chat_notices_conversation ON chat_notices(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS chat_notices_bot ON chat_notices(bot_id);
CREATE INDEX IF NOT EXISTS chat_notices_kind ON chat_notices(kind, created_at);
