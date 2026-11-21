-- Persist MCP server behavior declarations with each catalog generation. These nullable
-- booleans are untrusted hints, never permission grants; NULL preserves "not declared".
ALTER TABLE connector_tools ADD COLUMN read_only_hint INTEGER
  CHECK(read_only_hint IS NULL OR read_only_hint IN (0,1));
ALTER TABLE connector_tools ADD COLUMN idempotent_hint INTEGER
  CHECK(idempotent_hint IS NULL OR idempotent_hint IN (0,1));
ALTER TABLE connector_tools ADD COLUMN destructive_hint INTEGER
  CHECK(destructive_hint IS NULL OR destructive_hint IN (0,1));
