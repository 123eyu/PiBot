DROP INDEX conversations_one_active_group;
CREATE TABLE group_current_topics (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE
);
INSERT INTO group_current_topics(group_id,conversation_id)
SELECT g.id,(SELECT c.id FROM conversations c WHERE c.group_id=g.id AND c.kind='group'
 ORDER BY c.archived_at IS NULL DESC,c.updated_at DESC,c.id DESC LIMIT 1) FROM groups g;
CREATE TABLE group_topic_creations (
  request_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
);
