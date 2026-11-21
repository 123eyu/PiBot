CREATE TABLE plugin_installations (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  digest TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('builtin','json','directory')),
  status TEXT NOT NULL CHECK(status IN ('installed','removing','removed')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX plugin_installations_page ON plugin_installations(status, created_at DESC, id DESC);
CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  plugin_installation_id TEXT NOT NULL REFERENCES plugin_installations(id),
  server_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  catalog_version INTEGER NOT NULL DEFAULT 0 CHECK(catalog_version >= 0),
  kind TEXT NOT NULL CHECK(kind IN ('mcp_remote','mcp_stdio','builtin','rest')),
  identity TEXT NOT NULL CHECK(identity IN ('user','bot')),
  name TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('disabled','starting','ready','idle','needs_setup','needs_auth','error','stopping')),
  status_detail_code TEXT,
  removed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plugin_installation_id, server_id)
);
CREATE INDEX connectors_page ON connectors(removed_at, created_at DESC, id DESC);
CREATE INDEX connectors_recovery ON connectors(enabled, status, updated_at, id);
CREATE TABLE connector_tools (
  connector_id TEXT NOT NULL REFERENCES connectors(id),
  catalog_version INTEGER NOT NULL CHECK(catalog_version >= 0),
  tool_name TEXT NOT NULL,
  description TEXT NOT NULL,
  schema_json TEXT NOT NULL CHECK(json_valid(schema_json)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  read_only INTEGER NOT NULL CHECK(read_only IN (0,1)),
  suggested_read_only INTEGER NOT NULL CHECK(suggested_read_only IN (0,1)),
  PRIMARY KEY(connector_id, catalog_version, tool_name)
);
CREATE TABLE connector_access (
  connector_id TEXT PRIMARY KEY REFERENCES connectors(id),
  mode TEXT NOT NULL CHECK(mode IN ('ask_first','all','selected')),
  bots_json TEXT NOT NULL CHECK(json_valid(bots_json))
);
CREATE TABLE connector_operations (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES plugin_installations(id),
  connector_id TEXT REFERENCES connectors(id),
  kind TEXT NOT NULL CHECK(kind IN ('enable','disable','restart','disconnect','uninstall')),
  target_revision INTEGER NOT NULL CHECK(target_revision > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN ('pending','running','stopping','done','error','cancelled')),
  phase TEXT NOT NULL CHECK(phase IN ('queued','setup','connecting','discovering','draining','finished')),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX connector_operations_recovery ON connector_operations(state, created_at, id);
CREATE UNIQUE INDEX connector_operations_active ON connector_operations(connector_id)
  WHERE state IN ('pending','running','stopping');
CREATE UNIQUE INDEX plugin_operations_active ON connector_operations(installation_id)
  WHERE connector_id IS NULL AND state IN ('pending','running','stopping');
