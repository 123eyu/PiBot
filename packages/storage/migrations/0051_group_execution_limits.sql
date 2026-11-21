CREATE TABLE group_execution_limits (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  limits_json TEXT NOT NULL CHECK(json_valid(limits_json)),
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at TEXT NOT NULL
);
-- Prefer the current coordinator's explicit topic limits when upgrading old per-member settings.
INSERT INTO group_execution_limits(group_id,limits_json,version,updated_at)
SELECT g.id,e.limits_json,1,e.updated_at FROM groups g
JOIN conversations c ON c.group_id=g.id AND c.kind='group' AND c.archived_at IS NULL
JOIN execution_settings e ON e.bot_id=g.coordinator_bot_id AND e.conversation_id=c.id;
