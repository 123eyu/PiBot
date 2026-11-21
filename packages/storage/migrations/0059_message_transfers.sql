CREATE TABLE IF NOT EXISTS message_transfers (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
