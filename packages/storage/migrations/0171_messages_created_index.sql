-- Sidebar search pages through every message newest first; without this index each page
-- would sort the whole table.
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
