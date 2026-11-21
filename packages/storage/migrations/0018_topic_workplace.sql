ALTER TABLE conversations ADD COLUMN workplace_folder_id TEXT;
ALTER TABLE conversations ADD COLUMN workplace_revision INTEGER NOT NULL DEFAULT 0 CHECK(workplace_revision >= 0);
CREATE INDEX runs_topic_active ON runs(conversation_id,status);
CREATE INDEX routine_runs_topic_active ON routine_runs(conversation_id,status);
