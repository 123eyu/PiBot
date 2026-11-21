CREATE TABLE run_events (
  seq INTEGER PRIMARY KEY,
  run_id TEXT,
  conversation_id TEXT,
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),
  at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  session_entry_id TEXT,
  CHECK((run_id IS NULL) = (conversation_id IS NULL))
);

CREATE INDEX run_events_run_seq ON run_events(run_id, seq);
CREATE INDEX run_events_conversation_seq ON run_events(conversation_id, seq);

CREATE TRIGGER run_events_no_update
BEFORE UPDATE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run_events is append-only');
END;

-- Rows are never edited. Deletion is allowed only for the owner-chosen retention cleanup
-- ("keep forever, can clean up"), which removes whole old runs.
