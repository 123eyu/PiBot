-- Models and Bots a paired phone may use while the computer is unreachable, and the
-- idempotency records of what that phone brought back. Grants go with the device; imports stay
-- (an uploaded chat remains on the computer after the phone is revoked).
CREATE TABLE IF NOT EXISTS remote_offline_models (
 grant_id TEXT PRIMARY KEY,
 device_id TEXT NOT NULL,
 provider_id TEXT NOT NULL,
 model_id TEXT NOT NULL,
 delivered_at TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(device_id, provider_id, model_id)
);
-- Maintainers 2026-11-12: every Bot may answer offline unless switched off; only the exceptions are kept.
CREATE TABLE IF NOT EXISTS remote_offline_bots_off (
 device_id TEXT NOT NULL,
 bot_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(device_id, bot_id)
);
CREATE TABLE IF NOT EXISTS remote_offline_topics (
 device_id TEXT NOT NULL,
 local_topic_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 bot_id TEXT NOT NULL,
 provider_id TEXT NOT NULL,
 model_id TEXT NOT NULL,
 seeded INTEGER NOT NULL DEFAULT 0 CHECK(seeded IN (0,1)),
 created_at TEXT NOT NULL,
 PRIMARY KEY(device_id, local_topic_id)
);
CREATE TABLE IF NOT EXISTS remote_offline_items (
 device_id TEXT NOT NULL,
 client_id TEXT NOT NULL,
 local_topic_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('message','audit','memory','egress')),
 target_id TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY(device_id, client_id)
);
CREATE INDEX IF NOT EXISTS remote_offline_items_topic ON remote_offline_items(device_id, local_topic_id, kind);
