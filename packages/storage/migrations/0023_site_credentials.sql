-- Saved website accounts. `secret` is one SecretCipher blob holding the username and the
-- password; nothing else in this table is secret. Which Bots may use a record is a join table so
-- deleting a Bot drops its access with it.
CREATE TABLE IF NOT EXISTS site_credentials (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL CHECK(length(site) BETWEEN 1 AND 300),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 200),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 1000),
  secret BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS site_credentials_order ON site_credentials(site, label, id);
CREATE TABLE IF NOT EXISTS site_credential_bots (
  credential_id TEXT NOT NULL REFERENCES site_credentials(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  PRIMARY KEY (credential_id, bot_id)
);
CREATE INDEX IF NOT EXISTS site_credential_bots_bot ON site_credential_bots(bot_id, credential_id);
