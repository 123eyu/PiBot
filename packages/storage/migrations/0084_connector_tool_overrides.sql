CREATE TABLE connector_tool_overrides (
  connector_id TEXT NOT NULL REFERENCES connectors(id),
  tool_name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  read_only INTEGER NOT NULL CHECK(read_only IN (0,1)),
  read_only_fingerprint TEXT,
  PRIMARY KEY(connector_id, tool_name)
);

-- Existing rows predate an explicit default/override distinction. Preserve enabled state as
-- user-owned, but leave the read-only fingerprint empty so a later catalog refresh requires
-- explicit reconfirmation before direct execution.
INSERT INTO connector_tool_overrides(
  connector_id, tool_name, enabled, read_only, read_only_fingerprint
)
  SELECT t.connector_id, t.tool_name, t.enabled, t.read_only, NULL
  FROM connector_tools t JOIN connectors c
    ON c.id=t.connector_id AND c.catalog_version=t.catalog_version;
