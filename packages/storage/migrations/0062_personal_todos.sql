-- Personal user items survive deleting a source Bot or conversation.
CREATE TABLE IF NOT EXISTS personal_todos (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, due_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('open','done')),
 source_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
 source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
 request_key TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS personal_todos_status_time ON personal_todos(status,created_at DESC,id DESC);
