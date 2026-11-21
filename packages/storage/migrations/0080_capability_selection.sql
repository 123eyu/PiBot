CREATE TABLE IF NOT EXISTS capability_selection (
  scope TEXT NOT NULL CHECK(scope IN ('global','group','bot')),
  scope_id TEXT NOT NULL DEFAULT '',
  capability_id TEXT NOT NULL,
  impl TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, scope_id, capability_id)
);
