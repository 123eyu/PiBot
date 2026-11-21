-- Existing topic_folders remain readonly; only explicit markers grant additional writes.
CREATE TABLE IF NOT EXISTS topic_writable_folders (
  conversation_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  PRIMARY KEY(conversation_id, folder_id),
  FOREIGN KEY(conversation_id, folder_id) REFERENCES topic_folders(conversation_id, folder_id) ON DELETE CASCADE
);
