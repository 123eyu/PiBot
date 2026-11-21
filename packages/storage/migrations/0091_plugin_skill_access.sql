-- Connection scope migration must not grant access to shared skill bodies or resources.
CREATE TABLE plugin_skill_access (
  installation_id TEXT PRIMARY KEY REFERENCES plugin_installations(id),
  mode TEXT NOT NULL CHECK(mode IN ('ask_first','all','selected')),
  bots_json TEXT NOT NULL CHECK(json_valid(bots_json)),
  groups_json TEXT NOT NULL CHECK(json_valid(groups_json))
);

INSERT INTO plugin_skill_access(installation_id,mode,bots_json,groups_json)
SELECT p.id,
       CASE WHEN m.state='failed' OR (m.installation_id IS NOT NULL AND (m.mode NOT IN ('ask_first','all','selected') OR NOT json_valid(m.bots_json) OR NOT json_valid(m.groups_json))) THEN 'selected' ELSE COALESCE(m.mode,'ask_first') END,
       CASE WHEN m.state='failed' OR (m.installation_id IS NOT NULL AND (m.mode NOT IN ('ask_first','all','selected') OR NOT json_valid(m.bots_json) OR NOT json_valid(m.groups_json))) THEN '[]' ELSE COALESCE(m.bots_json,'[]') END,
       CASE WHEN m.state='failed' OR (m.installation_id IS NOT NULL AND (m.mode NOT IN ('ask_first','all','selected') OR NOT json_valid(m.bots_json) OR NOT json_valid(m.groups_json))) THEN '[]' ELSE COALESCE(m.groups_json,'[]') END
FROM plugin_installations p
LEFT JOIN connection_access_migrations m ON m.installation_id=p.id;
