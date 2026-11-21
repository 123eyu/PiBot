-- Installations of the retired built-in GitHub / Notion / Figma apps that have no
-- live connection (never connected, or disconnected earlier) carry no data or keys worth keeping
-- and cannot work any more; 0116 kept them, so they showed as MCP rows that do nothing. Mark them
-- removed the same way uninstalling does; installations still backing a live connection stay.
UPDATE plugin_installations
SET status='removed', revision=revision+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE plugin_id IN ('pibot.github','pibot.notion','pibot.figma')
  AND status='installed'
  AND NOT EXISTS (
    SELECT 1 FROM connectors c WHERE c.plugin_installation_id=plugin_installations.id AND c.removed_at IS NULL
  );
