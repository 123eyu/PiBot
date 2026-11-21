CREATE TABLE secrets_meta (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  assignment_json TEXT NOT NULL CHECK(json_valid(assignment_json)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- A process restart or delete/recreate must not make an old approval valid again.
CREATE TABLE secret_revision_sequence (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
INSERT INTO secret_revision_sequence(id, revision) VALUES (1, 0);
CREATE INDEX grants_secret_name ON grants(json_extract(scope, '$.name'))
  WHERE json_extract(scope, '$.kind') = 'secret' AND revoked_at IS NULL;
