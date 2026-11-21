CREATE TABLE group_permissions (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  overrides TEXT NOT NULL CHECK(json_valid(overrides))
);
ALTER TABLE grants ADD COLUMN group_id TEXT REFERENCES groups(id) ON DELETE CASCADE;
CREATE INDEX grants_group_page ON grants(group_id, revoked_at, created_at, id);
