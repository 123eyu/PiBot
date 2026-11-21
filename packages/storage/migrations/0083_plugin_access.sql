CREATE TABLE plugin_access (
  installation_id TEXT PRIMARY KEY REFERENCES plugin_installations(id),
  mode TEXT NOT NULL CHECK(mode IN ('ask_first','all','selected')),
  bots_json TEXT NOT NULL CHECK(json_valid(bots_json)),
  groups_json TEXT NOT NULL CHECK(json_valid(groups_json))
);

INSERT INTO plugin_access(installation_id,mode,bots_json,groups_json)
SELECT p.id,
       COALESCE((SELECT a.mode FROM connectors c JOIN connector_access a ON a.connector_id=c.id
                 WHERE c.plugin_installation_id=p.id ORDER BY c.created_at,c.id LIMIT 1),'ask_first'),
       COALESCE((SELECT a.bots_json FROM connectors c JOIN connector_access a ON a.connector_id=c.id
                 WHERE c.plugin_installation_id=p.id ORDER BY c.created_at,c.id LIMIT 1),'[]'),
       '[]'
FROM plugin_installations p;
