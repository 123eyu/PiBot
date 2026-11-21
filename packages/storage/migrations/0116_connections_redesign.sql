-- Where a brought-over skill or installation came from. origin_tool is shown
-- (「从 Claude Code 带过来」); origin_key is the scan's stable key of that item (tool + real path /
-- config entry), so a rescan recognises it even after it was renamed 「x 2」. Both NULL for
-- everything made in Pi Bot. Copies given to other Bots keep them.
ALTER TABLE skills ADD COLUMN origin_tool TEXT
  CHECK(origin_tool IS NULL OR origin_tool IN ('claude-code','codex','cursor','pi','opencode'));
ALTER TABLE skills ADD COLUMN origin_key TEXT;
CREATE INDEX IF NOT EXISTS skills_origin_key ON skills(origin_key) WHERE origin_key IS NOT NULL;
ALTER TABLE plugin_installations ADD COLUMN origin_tool TEXT
  CHECK(origin_tool IS NULL OR origin_tool IN ('claude-code','codex','cursor','pi','opencode'));
ALTER TABLE plugin_installations ADD COLUMN origin_key TEXT;

-- GitHub / Notion / Figma are no longer built in. People who already connected one keep the
-- connection, its access and its secrets: it becomes an ordinary imported MCP that they can manage
-- or remove like any other (no data is deleted here).
-- First pin each current tool's switch and read-only state as the user's own setting: without the
-- built-in definition a catalog refresh would otherwise reset them to plain-MCP defaults (all on,
-- all writes), re-enabling e.g. GitHub's merge / delete tools. The read-only fingerprint stays
-- empty, so a read-only tool needs one fresh confirmation before it runs unasked again.
INSERT OR IGNORE INTO connector_tool_overrides(
  connector_id, tool_name, enabled, read_only, read_only_fingerprint
)
  SELECT t.connector_id, t.tool_name, t.enabled, t.read_only, NULL
  FROM connector_tools t
  JOIN connectors c ON c.id=t.connector_id AND c.catalog_version=t.catalog_version
  JOIN plugin_installations p ON p.id=c.plugin_installation_id
  WHERE p.source_kind='builtin' AND p.plugin_id IN ('pibot.github','pibot.notion','pibot.figma')
    AND c.removed_at IS NULL;
UPDATE plugin_installations SET source_kind='json'
WHERE source_kind='builtin' AND plugin_id IN ('pibot.github','pibot.notion','pibot.figma');

-- Their capability ids are gone from the app: drop the trusted mappings and any selection of them
-- (a selection only chose which connection serves the capability; access and data are untouched).
UPDATE connector_tools SET capability_id=NULL, capability_tool=NULL, capability_read_only=NULL
WHERE capability_id IN ('github','notion','figma');
DELETE FROM capability_selection WHERE capability_id IN ('github','notion','figma');
