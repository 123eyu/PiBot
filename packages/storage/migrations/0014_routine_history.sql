-- Global and original-Bot history must seek without scanning each task or day.
CREATE INDEX IF NOT EXISTS routine_runs_history ON routine_runs(created_at,id);
CREATE INDEX IF NOT EXISTS routine_runs_bot_history ON routine_runs(bot_id,created_at,id);
