CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
  name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
  width INTEGER, height INTEGER, path TEXT NOT NULL, text_path TEXT,
  truncated INTEGER NOT NULL DEFAULT 0, sent_percent REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX attachments_message_id ON attachments(message_id);
