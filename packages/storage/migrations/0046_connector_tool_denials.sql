CREATE TABLE connector_tool_denials (
  connector_id TEXT NOT NULL REFERENCES connectors(id),
  tool_name TEXT NOT NULL,
  PRIMARY KEY(connector_id, tool_name)
);
INSERT INTO connector_tool_denials(connector_id, tool_name)
  SELECT DISTINCT connector_id, tool_name FROM connector_tools WHERE enabled = 0;
