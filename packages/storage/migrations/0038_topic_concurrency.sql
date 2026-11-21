-- Each topic owns one JSONL writer; a Bot can work in other topics at the same time.
DROP INDEX IF EXISTS runs_one_running_bot;
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_running_topic
  ON runs(bot_id, conversation_id) WHERE status='running';
