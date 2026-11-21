-- A built-in role / group template now updates itself on start, including the fields the
-- user had changed. This row keeps the Bot's or group's own values from right before the last such
-- overwrite, so「已自动更新，可恢复上一版」can put them back. It holds text (norms, announcement)
-- and skill packages on purpose: a restore has to write the exact previous version, and hashes
-- cannot do that. Local database only; nothing is sent anywhere.
CREATE TABLE IF NOT EXISTS builtin_recoveries (
  target_kind TEXT NOT NULL CHECK(target_kind IN ('bot', 'group')),
  target_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  from_version INTEGER NOT NULL CHECK(from_version >= 0),
  to_version INTEGER NOT NULL CHECK(to_version >= 1),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id)
);
