-- App metadata is outside the executable/readable source package. Empty package_id
-- denotes the private materialization; snapshots follow update/rollback package versions.
CREATE TABLE skill_document_metadata (
  owner TEXT NOT NULL,
  package_id TEXT NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY(owner, package_id)
);
CREATE INDEX skill_document_metadata_package ON skill_document_metadata(package_id);
CREATE TRIGGER skills_document_metadata_delete AFTER DELETE ON skills BEGIN
  DELETE FROM skill_document_metadata WHERE owner='bot:'||OLD.id;
END;
CREATE TRIGGER group_skills_document_metadata_delete AFTER DELETE ON group_member_skills BEGIN
  DELETE FROM skill_document_metadata WHERE owner='group:'||OLD.id;
END;
CREATE TRIGGER packages_document_metadata_delete AFTER DELETE ON skill_packages BEGIN
  DELETE FROM skill_document_metadata WHERE package_id=OLD.id;
END;
