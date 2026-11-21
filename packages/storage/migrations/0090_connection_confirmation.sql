ALTER TABLE connectors ADD COLUMN confirmation_mode TEXT NOT NULL DEFAULT 'read_write'
  CHECK(confirmation_mode IN ('read_write','always_ask','read_only'));

-- Preserve the old skill grant until each installation's skills have been copied.
CREATE TABLE connection_access_migrations (
  installation_id TEXT PRIMARY KEY REFERENCES plugin_installations(id),
  mode TEXT NOT NULL,
  bots_json TEXT NOT NULL,
  groups_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','migrated','failed'))
);
INSERT INTO connection_access_migrations(installation_id,mode,bots_json,groups_json)
SELECT a.installation_id,a.mode,a.bots_json,a.groups_json
FROM plugin_access a JOIN plugin_installations p ON p.id=a.installation_id
WHERE p.status='installed';
