-- External coding agents (Codex, Claude Agent, Cursor, OpenCode, a custom ACP
-- command) as Bots. `kind` marks such a Bot; everything about the agent lives in its own tables,
-- and nothing here stores an agent's account, token or prompt text.
ALTER TABLE bots ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind = 'agent');

CREATE TABLE external_agent_bots (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL CHECK (agent_id IN ('codex', 'claude', 'cursor', 'opencode', 'custom')),
  -- Custom launch command: name, program, arguments, own folders and network allowlist.
  custom_json TEXT CHECK (custom_json IS NULL OR json_valid(custom_json)),
  adapter_version TEXT,
  created_at TEXT NOT NULL
);

-- The agent's own session id per topic, resumed with session/load after a restart. Options are
-- what the agent last offered (modes, models); preferences are what the user picked for the topic.
CREATE TABLE external_agent_sessions (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  options_json TEXT CHECK (options_json IS NULL OR json_valid(options_json)),
  preferences_json TEXT CHECK (preferences_json IS NULL OR json_valid(preferences_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, conversation_id)
);

-- Windows has no command sandbox: the user confirmed running this agent unisolated. The subject
-- is a known agent's id, or `custom:<bot id>:<sha256 of program and arguments>` so a confirmation
-- covers exactly one custom command and lapses when that command changes.
CREATE TABLE external_agent_confirmations (
  subject TEXT PRIMARY KEY CHECK (
    subject IN ('codex', 'claude', 'cursor', 'opencode') OR subject LIKE 'custom:%'
  ),
  confirmed_at TEXT NOT NULL
);
