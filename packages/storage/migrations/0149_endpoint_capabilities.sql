CREATE TABLE endpoint_capabilities (
 endpoint_id TEXT NOT NULL, capability_id TEXT NOT NULL, version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('auto_on','user_on','off')),
 availability TEXT NOT NULL CHECK(availability IN ('available','local_switch_off','unsupported')),
 first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_called_at TEXT,
 scope TEXT NOT NULL, attributes TEXT NOT NULL, user_managed INTEGER NOT NULL DEFAULT 0 CHECK(user_managed IN (0,1)),
 PRIMARY KEY(endpoint_id,capability_id)
);
