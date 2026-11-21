-- AF-5: topic-scoped planning metadata is separate from group task ownership and chat text.
CREATE TABLE IF NOT EXISTS execution_settings (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('execute', 'plan')),
  limits_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(bot_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS execution_todo (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  plan_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(bot_id, conversation_id)
);
