-- A render's check summary outlives its in-memory thumbnails, so a chat step can still
-- list what was wrong after the images expire. The summary is small JSON; the PNGs stay in memory.
CREATE TABLE office_render_checks (
  run_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, message_id, tool_call_id)
);
CREATE INDEX office_render_checks_created ON office_render_checks(created_at);
