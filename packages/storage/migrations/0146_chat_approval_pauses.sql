CREATE TABLE chat_approval_pauses (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
  call_hash TEXT NOT NULL,
  facts_hash TEXT NOT NULL,
  paused_at TEXT NOT NULL,
  resumed_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  choice_json TEXT,
  resumed_call_id TEXT,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0,1))
);
CREATE INDEX chat_approval_pauses_resume ON chat_approval_pauses(resumed_run_id);

-- A stopped card must not reserve the active approval lane for its conversation.
ALTER TABLE approvals ADD COLUMN timeout_paused INTEGER NOT NULL DEFAULT 0 CHECK (timeout_paused IN (0,1));
DROP INDEX approvals_bot_conversation_chat_pending;
CREATE UNIQUE INDEX approvals_bot_conversation_chat_pending ON approvals(bot_id,conversation_id)
  WHERE status='pending' AND source='chat' AND timeout_paused=0 AND json_type(request,'$.draft') IS NULL;
