-- Browser compatibility is independent from every member's direct-chat profile.
-- Empty means the existing default (on); null means explicitly off.
ALTER TABLE groups ADD COLUMN google_compat_at TEXT DEFAULT '';
CREATE TABLE group_computer_app_names (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  names TEXT NOT NULL CHECK(json_valid(names))
);
