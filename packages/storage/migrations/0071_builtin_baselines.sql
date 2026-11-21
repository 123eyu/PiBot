-- What a built-in role / group template looked like when a Bot or group took it (at
-- creation or at the last「采用新版」), so a later version can update only what the user has not
-- changed. `baseline` holds hashes and built-in values (never personas, norms or skill text);
-- `dismissed_version` is the version the user answered「保留当前」for. Bots and groups made
-- before this migration have no row: brain compares them against the release history shipped
-- with the built-ins instead, and treats anything it cannot recognise as changed by the user.
CREATE TABLE IF NOT EXISTS builtin_bot_baselines (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  baseline TEXT NOT NULL CHECK(json_valid(baseline)),
  dismissed_version INTEGER CHECK(dismissed_version IS NULL OR dismissed_version >= 1),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS builtin_group_baselines (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  -- 0: the template was recognised but not which version (no recorded value matched).
  version INTEGER NOT NULL CHECK(version >= 0),
  baseline TEXT NOT NULL CHECK(json_valid(baseline)),
  dismissed_version INTEGER CHECK(dismissed_version IS NULL OR dismissed_version >= 1),
  updated_at TEXT NOT NULL
);
