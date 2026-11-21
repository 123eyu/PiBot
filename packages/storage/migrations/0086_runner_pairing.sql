CREATE TABLE remote_devices_runner (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'phone' CHECK(kind IN ('phone','runner')),
  public_key TEXT,
  room TEXT,
  push_token TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
INSERT INTO remote_devices_runner SELECT id,name,COALESCE(kind,'phone'),public_key,room,push_token,created_at,last_seen_at,revoked_at FROM remote_devices;
DROP TABLE remote_devices;
ALTER TABLE remote_devices_runner RENAME TO remote_devices;
CREATE UNIQUE INDEX remote_device_public_key ON remote_devices(public_key) WHERE revoked_at IS NULL;
CREATE INDEX remote_devices_active_page ON remote_devices(revoked_at,id);
ALTER TABLE working_folders ADD COLUMN location TEXT NOT NULL DEFAULT 'local';
