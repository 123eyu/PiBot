-- Tools a connection's server marks read-only, and not destructive,
-- count as reads. Catalogs published from now on start that way; this brings the current ones
-- in line. A tool the person set themselves (connector_tool_overrides) keeps that choice.
UPDATE connector_tools
SET read_only = 1
WHERE read_only = 0
  AND read_only_hint = 1
  AND COALESCE(destructive_hint, 0) = 0
  AND NOT EXISTS (
    SELECT 1 FROM connector_tool_overrides o
    WHERE o.connector_id = connector_tools.connector_id AND o.tool_name = connector_tools.tool_name
  );
