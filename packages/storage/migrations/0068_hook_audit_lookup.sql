-- Completion notification receipts are looked up once per successful run, never by a full audit scan.
CREATE INDEX IF NOT EXISTS audit_log_run_kind ON audit_log(run_id, kind);
