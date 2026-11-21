-- A stdio MCP the person moved outside the sandbox (macOS / Linux). The confirmation
-- receipt bound to the configuration lives in the secret store; this column is the visible state.
ALTER TABLE connectors ADD COLUMN outside_sandbox INTEGER NOT NULL DEFAULT 0
  CHECK(outside_sandbox IN (0,1));
