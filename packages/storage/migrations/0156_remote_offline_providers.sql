CREATE TABLE IF NOT EXISTS remote_offline_providers (
  grant_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES remote_devices(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(device_id, provider_id)
);
CREATE INDEX IF NOT EXISTS remote_offline_providers_device ON remote_offline_providers(device_id, created_at);
INSERT OR IGNORE INTO remote_offline_providers(grant_id, device_id, provider_id, delivered_at, created_at)
SELECT MIN(grant_id), device_id, provider_id, MAX(delivered_at), MIN(created_at)
FROM remote_offline_models GROUP BY device_id, provider_id;
