-- Again: 0120 converted the catalogs, but the first restart's built-in defaults step then
-- reset non-built-in connections to "everything writes" (fixed in connector-service). Same rule.
UPDATE connector_tools
SET read_only = 1
WHERE read_only = 0
  AND read_only_hint = 1
  AND COALESCE(destructive_hint, 0) = 0
  AND NOT EXISTS (
    SELECT 1 FROM connector_tool_overrides o
    WHERE o.connector_id = connector_tools.connector_id AND o.tool_name = connector_tools.tool_name
  );
