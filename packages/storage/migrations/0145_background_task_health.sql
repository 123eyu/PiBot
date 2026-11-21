-- Consecutive failures per background task, object and reason code. A success deletes the
-- object's rows for that task, so the inbox card disappears exactly when the worker works again.
CREATE TABLE IF NOT EXISTS background_task_health (
 task TEXT NOT NULL,
 subject TEXT NOT NULL,
 reason_code TEXT NOT NULL,
 streak INTEGER NOT NULL CHECK(streak > 0),
 first_failed_at TEXT NOT NULL,
 last_failed_at TEXT NOT NULL,
 PRIMARY KEY (task, subject, reason_code)
);
