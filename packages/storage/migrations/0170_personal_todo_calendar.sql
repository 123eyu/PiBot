ALTER TABLE personal_todos ADD COLUMN color TEXT;
ALTER TABLE personal_todos ADD COLUMN sticker TEXT;
ALTER TABLE personal_todos ADD COLUMN end_at TEXT;
CREATE INDEX IF NOT EXISTS personal_todos_date ON personal_todos(status,substr(due_at,1,10),end_at);
CREATE INDEX IF NOT EXISTS personal_todos_deadline ON personal_todos(status,COALESCE(end_at,substr(due_at,1,10)),created_at,id);
