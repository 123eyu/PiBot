CREATE TABLE review_executions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  task_id TEXT UNIQUE REFERENCES task_instances(id) ON DELETE SET NULL,
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  root TEXT NOT NULL,
  snapshot_bytes INTEGER NOT NULL CHECK(snapshot_bytes>=0),
  created_at TEXT NOT NULL,
  UNIQUE(parent_run_id,tool_call_id)
);
CREATE INDEX review_execution_scope ON review_executions(bot_id,conversation_id,created_at DESC,id DESC);
CREATE TABLE delivery_evidence (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  root_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('command','screenshot','review','unverified')),
  source_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  UNIQUE(root_run_id,kind,source_id)
);
CREATE INDEX delivery_evidence_scope ON delivery_evidence(bot_id,conversation_id,created_at DESC,id DESC);
