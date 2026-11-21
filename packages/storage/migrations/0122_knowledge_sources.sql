-- Knowledge sources live in the person's own tools (Obsidian vault, Notion workspace).
-- Only the reference and who may use it are stored; note content and index copies stay out of the
-- database on purpose.
CREATE TABLE knowledge_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('obsidian','notion')),
  name TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX knowledge_sources_page ON knowledge_sources(created_at DESC, id DESC);
-- One row per Bot / group, so "which sources may this target use" stays an indexed lookup.
CREATE TABLE knowledge_assignments (
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('bot','group')),
  target_id TEXT NOT NULL,
  PRIMARY KEY(source_id, target_kind, target_id)
);
CREATE INDEX knowledge_assignments_target ON knowledge_assignments(target_kind, target_id);
