CREATE TABLE IF NOT EXISTS message_attachment_links (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS message_attachment_links_attachment ON message_attachment_links(attachment_id);
