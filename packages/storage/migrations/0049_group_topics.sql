DROP INDEX conversations_one_group;
CREATE UNIQUE INDEX conversations_one_active_group ON conversations(group_id)
  WHERE kind='group' AND archived_at IS NULL;
CREATE TABLE group_topic_workspaces (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  folders TEXT NOT NULL CHECK(json_valid(folders)),
  primary_folder_id TEXT,
  revision INTEGER NOT NULL CHECK(revision>=0)
);
CREATE INDEX conversations_group_topics ON conversations(group_id,updated_at,id) WHERE kind='group';
