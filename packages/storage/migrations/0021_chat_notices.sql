-- System records shown as centered lines in a chat (first kind: browser hand-back). Kept out of
-- `messages` so model context, read_messages, search and unread counts never see them.
-- Cascades: deleting a topic, group or Bot removes its records with it.
CREATE TABLE IF NOT EXISTS chat_notices (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('browser_handback')),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_notices_conversation ON chat_notices(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS chat_notices_bot ON chat_notices(bot_id);
