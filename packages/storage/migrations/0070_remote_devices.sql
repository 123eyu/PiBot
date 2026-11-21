CREATE TABLE IF NOT EXISTS remote_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  desktop_id TEXT NOT NULL,
  settings TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'phone'),
  public_key TEXT,
  room TEXT,
  push_token TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS remote_device_public_key ON remote_devices(public_key) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS remote_devices_active_page ON remote_devices(revoked_at, id);
CREATE TABLE IF NOT EXISTS remote_send_receipts (
  device_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (device_id, client_id)
);
