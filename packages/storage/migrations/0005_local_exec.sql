ALTER TABLE bots ADD COLUMN permission_overrides TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(permission_overrides));

CREATE TABLE working_folders (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id),
  path TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(bot_id, path), UNIQUE(bot_id, id)
);
CREATE INDEX working_folders_bot_position ON working_folders(bot_id, position);
CREATE TABLE bot_workplace (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id), current_folder_id TEXT,
  FOREIGN KEY(bot_id, current_folder_id) REFERENCES working_folders(bot_id, id)
);
CREATE TABLE grants (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), category TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (json_valid(scope)), created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX grants_bot_created ON grants(bot_id, created_at, id) WHERE revoked_at IS NULL;

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
  tool_call_id TEXT NOT NULL, tool TEXT NOT NULL, summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','error','blocked','aborted')),
  exit_code INTEGER, duration_ms INTEGER CHECK (duration_ms >= 0), log_path TEXT,
  created_at TEXT NOT NULL, finished_at TEXT, approval_id TEXT REFERENCES approvals(id),
  UNIQUE(message_id, tool_call_id)
);
CREATE INDEX tool_calls_message_created ON tool_calls(message_id, created_at, id);
CREATE INDEX messages_run_id ON messages(run_id);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), run_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id), tool_call_id TEXT NOT NULL,
  category TEXT NOT NULL, risk TEXT NOT NULL CHECK (risk IN ('normal','danger')),
  request TEXT NOT NULL CHECK (json_valid(request)),
  status TEXT NOT NULL CHECK (status IN ('pending','allowed','denied','auto_denied','cancelled','expired')),
  remembered INTEGER NOT NULL DEFAULT 0 CHECK (remembered IN (0,1)),
  created_at TEXT NOT NULL, resolved_at TEXT, expires_at TEXT NOT NULL,
  FOREIGN KEY(message_id, tool_call_id) REFERENCES tool_calls(message_id, tool_call_id),
  CHECK (remembered = 0 OR (status = 'allowed' AND risk = 'normal'))
);
CREATE UNIQUE INDEX approvals_bot_pending ON approvals(bot_id) WHERE status = 'pending';
CREATE INDEX approvals_pending_created ON approvals(status, created_at, id);
CREATE INDEX approvals_bot_created ON approvals(bot_id, created_at, id);
CREATE INDEX approvals_tool_call ON approvals(message_id, tool_call_id);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, bot_id TEXT NOT NULL,
  kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL CHECK (json_valid(detail)), run_id TEXT
);
-- Audit survives Bot/message deletion; only retention cleanup removes these facts.
CREATE INDEX audit_log_at ON audit_log(at, id);
CREATE INDEX audit_log_bot_at ON audit_log(bot_id, at, id);
CREATE INDEX audit_log_kind_at ON audit_log(kind, at, id);
