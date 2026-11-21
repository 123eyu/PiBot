CREATE TABLE skill_packages (
  id TEXT PRIMARY KEY CHECK(length(id)=16 AND id NOT GLOB '*[^0-9a-f]*'),
  digest TEXT NOT NULL CHECK(length(digest)=64),
  created_at TEXT NOT NULL,
  unreferenced_at TEXT
);
ALTER TABLE skills ADD COLUMN package_id TEXT REFERENCES skill_packages(id);
ALTER TABLE group_member_skills ADD COLUMN package_id TEXT REFERENCES skill_packages(id);
CREATE INDEX skills_package ON skills(package_id);
CREATE INDEX group_skills_package ON group_member_skills(package_id);
CREATE TRIGGER skills_package_insert AFTER INSERT ON skills BEGIN
  UPDATE skill_packages SET unreferenced_at=NULL WHERE id=NEW.package_id;
END;
CREATE TRIGGER skills_package_update AFTER UPDATE OF package_id ON skills BEGIN
  UPDATE skill_packages SET unreferenced_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=OLD.package_id AND NOT EXISTS(SELECT 1 FROM skills WHERE package_id=skill_packages.id) AND NOT EXISTS(SELECT 1 FROM group_member_skills WHERE package_id=skill_packages.id);
  UPDATE skill_packages SET unreferenced_at=NULL WHERE id=NEW.package_id;
END;
CREATE TRIGGER skills_package_delete AFTER DELETE ON skills BEGIN
  UPDATE skill_packages SET unreferenced_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=OLD.package_id AND NOT EXISTS(SELECT 1 FROM skills WHERE package_id=skill_packages.id) AND NOT EXISTS(SELECT 1 FROM group_member_skills WHERE package_id=skill_packages.id);
END;
CREATE TRIGGER group_member_skills_package_insert AFTER INSERT ON group_member_skills BEGIN
  UPDATE skill_packages SET unreferenced_at=NULL WHERE id=NEW.package_id;
END;
CREATE TRIGGER group_member_skills_package_update AFTER UPDATE OF package_id ON group_member_skills BEGIN
  UPDATE skill_packages SET unreferenced_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=OLD.package_id AND NOT EXISTS(SELECT 1 FROM skills WHERE package_id=skill_packages.id) AND NOT EXISTS(SELECT 1 FROM group_member_skills WHERE package_id=skill_packages.id);
  UPDATE skill_packages SET unreferenced_at=NULL WHERE id=NEW.package_id;
END;
CREATE TRIGGER group_member_skills_package_delete AFTER DELETE ON group_member_skills BEGIN
  UPDATE skill_packages SET unreferenced_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=OLD.package_id AND NOT EXISTS(SELECT 1 FROM skills WHERE package_id=skill_packages.id) AND NOT EXISTS(SELECT 1 FROM group_member_skills WHERE package_id=skill_packages.id);
END;
