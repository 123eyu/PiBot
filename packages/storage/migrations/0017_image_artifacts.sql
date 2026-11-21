CREATE TABLE image_artifacts (
  source_run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK (json_valid(target)),
  model TEXT NOT NULL CHECK (json_valid(model)),
  generation_succeeded_at TEXT,
  saving_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX image_artifacts_message ON image_artifacts(source_message_id);
CREATE TABLE image_workspace_receipts (
  key TEXT PRIMARY KEY,
  source_run_id TEXT NOT NULL REFERENCES image_artifacts(source_run_id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  receipt TEXT NOT NULL CHECK (json_valid(receipt)),
  created_at TEXT NOT NULL,
  UNIQUE (source_run_id, attachment_id)
);
