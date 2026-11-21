-- The Notion connection a knowledge source owns must be recognisable apart from a Notion
-- MCP the person imported themselves. Before this task the two looked identical (`source_kind`
-- is 'json' for both since 0116 retired the built-in app), so startup repair and removal could
-- tighten or delete a person's own working connection. The marker is a separate table so
-- `SELECT *` row shapes stay unchanged; it is written when the brain installs the connection and
-- only the brain-owned path reads it.
CREATE TABLE knowledge_managed_installations (
  installation_id TEXT PRIMARY KEY REFERENCES plugin_installations(id),
  created_at TEXT NOT NULL
);

-- Installations that already exist have no marker. A source still pointing at one makes the
-- ownership unambiguous: the brain created that connection for the source, so it is safe to
-- tighten and to remove with the source.
INSERT OR IGNORE INTO knowledge_managed_installations(installation_id, created_at)
SELECT p.id, strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM plugin_installations p
WHERE p.plugin_id='pibot.notion'
  AND EXISTS (
    SELECT 1 FROM connectors c
    JOIN knowledge_sources k ON c.id=json_extract(k.config_json,'$.connectorId')
    WHERE c.plugin_installation_id=p.id AND c.removed_at IS NULL AND k.kind='notion'
  );

-- A source can be deleted, leaving its connection behind with no pointer. Only those created
-- after managed connections went live and whose manifest is exactly
-- `notionManifest()` can be one of ours; anything older predates the feature and may be the
-- person's own connection, so it stays untouched. Both sides of that check are fingerprints, not
-- permissions: a mismatch only means "do not tighten, do not remove".
INSERT OR IGNORE INTO knowledge_managed_installations(installation_id, created_at)
SELECT p.id, strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM plugin_installations p
WHERE p.plugin_id='pibot.notion'
  AND p.status='installed'
  AND p.created_at >= '2026-11-05T08:55:00.000Z'
  AND json_array_length(p.manifest_json,'$.servers')=1
  AND json_extract(p.manifest_json,'$.servers[0].id')='notion'
  AND json_extract(p.manifest_json,'$.servers[0].url')='https://mcp.notion.com/mcp'
  AND json_extract(p.manifest_json,'$.servers[0].auth.kind')='oauth'
  AND NOT EXISTS (
    SELECT 1 FROM connectors c
    JOIN knowledge_sources k ON c.id=json_extract(k.config_json,'$.connectorId')
    WHERE c.plugin_installation_id=p.id AND c.removed_at IS NULL AND k.kind='notion'
  );
