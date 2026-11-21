-- Automatic check for development roles.
-- Per Bot: the switch and how many follow-up fix rounds a failed check may start. NULL = unset
-- (off / default rounds); a role sets the default when it creates the Bot, the user changes it.
CREATE TABLE IF NOT EXISTS bot_auto_check (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  enabled INTEGER CHECK(enabled IS NULL OR enabled IN (0, 1)),
  rounds INTEGER CHECK(rounds IS NULL OR rounds BETWEEN 0 AND 3),
  updated_at TEXT NOT NULL
);
-- Per folder (the conversation's primary folder, by real path): the confirmed check commands as a
-- JSON array of strings. No row = not known yet; '[]' = the user chose not to check this folder.
CREATE TABLE IF NOT EXISTS folder_checks (
  folder_key TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  commands TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Chat records gain the check result and the "propose a check command" card. SQLite cannot widen
-- a CHECK constraint in place; nothing references chat_notices, so the table is copied over.
CREATE TABLE chat_notices_v2 (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('browser_handback', 'auto_check', 'auto_check_proposal')),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO chat_notices_v2 (id, conversation_id, bot_id, kind, detail, created_at)
  SELECT id, conversation_id, bot_id, kind, detail, created_at FROM chat_notices;
DROP TABLE chat_notices;
ALTER TABLE chat_notices_v2 RENAME TO chat_notices;
CREATE INDEX IF NOT EXISTS chat_notices_conversation ON chat_notices(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS chat_notices_bot ON chat_notices(bot_id);
