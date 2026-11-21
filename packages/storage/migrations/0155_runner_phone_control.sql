CREATE TABLE IF NOT EXISTS remote_runner_phone_control (
 phone_id TEXT NOT NULL,
 runner_id TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 0,
 grant_json TEXT,
 delivered_revision INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(phone_id,runner_id)
);
CREATE INDEX IF NOT EXISTS remote_runner_phone_control_runner ON remote_runner_phone_control(runner_id,phone_id);
