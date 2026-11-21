CREATE TABLE send_drafts (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL,
  identity TEXT NOT NULL CHECK(identity IN ('user','bot')),
  target TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  content_length INTEGER NOT NULL CHECK(content_length BETWEEN 0 AND 65536),
  dispatch_started INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_started IN (0,1)),
  edited INTEGER NOT NULL DEFAULT 0 CHECK(edited IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','discarded','expired','failed','unknown')),
  resolved_at TEXT,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 1048576)
);
CREATE INDEX send_drafts_status ON send_drafts(status,approval_id);
CREATE INDEX send_drafts_connector ON send_drafts(connector_id,status);
-- Durable drafts do not suspend a run. They may coexist with one blocking approval.
DROP INDEX approvals_bot_conversation_chat_pending;
DROP INDEX approvals_run_pending;
CREATE UNIQUE INDEX approvals_bot_conversation_chat_pending ON approvals(bot_id,conversation_id)
  WHERE status='pending' AND source='chat' AND json_type(request,'$.draft') IS NULL;
CREATE UNIQUE INDEX approvals_run_pending ON approvals(run_id)
  WHERE status='pending' AND json_type(request,'$.draft') IS NULL;
ALTER TABLE connector_tools ADD COLUMN draft_binding TEXT CHECK(draft_binding IS NULL OR json_valid(draft_binding));
-- A stored permissions row has no per-category edit provenance. Preserve it,
-- even if it equals the old default; only absent/default-owned levels may change.
INSERT OR IGNORE INTO settings(key,value) VALUES ('permissions.send_out_default_v1','true');
