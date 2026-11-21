-- Capability suggestions are trusted local metadata derived from a complete catalog.
-- They never grant access; selection and policy still decide whether a tool is visible or usable.
ALTER TABLE connector_tools ADD COLUMN capability_id TEXT
  CHECK(capability_id IS NULL OR capability_id IN (
    'files.read','files.write','web.fetch','web.search','browser',
    'calendar','contacts','github','notion','figma'
  ));
ALTER TABLE connector_tools ADD COLUMN capability_tool TEXT;
ALTER TABLE connector_tools ADD COLUMN capability_read_only INTEGER
  CHECK(capability_read_only IS NULL OR capability_read_only IN (0,1));
CREATE INDEX connector_tools_capability
  ON connector_tools(connector_id,catalog_version,capability_id)
  WHERE capability_id IS NOT NULL;
