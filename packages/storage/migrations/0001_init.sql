CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE bots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, is_main INTEGER NOT NULL DEFAULT 0,
  avatar_shape TEXT NOT NULL, avatar_color TEXT NOT NULL, avatar_eyes TEXT NOT NULL,
  model_provider TEXT, model_id TEXT, thinking_level TEXT NOT NULL DEFAULT 'medium',
  system_prompt TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('dm')),
  bot_id TEXT NOT NULL REFERENCES bots(id), pi_session_file TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant','error')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('streaming','done','error','aborted')),
  run_id TEXT, error_code TEXT, usage TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE providers (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('builtin','custom')),
  config TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE secrets (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL,
  ciphertext BLOB NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT,
  UNIQUE(scope, name)
);

CREATE INDEX conversations_bot_id ON conversations(bot_id);
CREATE INDEX messages_conversation_created ON messages(conversation_id, created_at);
