-- One row per imported skill, holding the source version and the packages a check or an
-- update left behind. A pending package is protected from cleanup until the user answers.
CREATE TABLE skill_updates (
  id TEXT PRIMARY KEY,
  source_version TEXT,
  digest TEXT NOT NULL CHECK(length(digest)=64),
  imported_at TEXT NOT NULL,
  checked_at TEXT,
  pending_package_id TEXT REFERENCES skill_packages(id) ON DELETE SET NULL,
  pending TEXT,
  previous_package_id TEXT REFERENCES skill_packages(id) ON DELETE SET NULL,
  previous TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX skill_updates_pending ON skill_updates(pending_package_id);
-- Skill ids are only unique inside their table, so the key also names where the skill lives.
CREATE TRIGGER skills_updates_delete AFTER DELETE ON skills BEGIN
  DELETE FROM skill_updates WHERE id='bot:'||OLD.id;
END;
CREATE TRIGGER group_skills_updates_delete AFTER DELETE ON group_member_skills BEGIN
  DELETE FROM skill_updates WHERE id='group:'||OLD.id;
END;
