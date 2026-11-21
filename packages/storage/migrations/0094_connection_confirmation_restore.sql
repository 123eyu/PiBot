-- Migration 0090 mapped "ask on first use, then remember" (ask_first) to "ask
-- every time", which stopped unattended uses that ran before (GitHub-triggered routines) and asks
-- on every read. Each connection whose mode is still exactly what that migration wrote gets one
-- queued restore check; the plugins capability settles each row at start (per-row, audited,
-- fail-closed to "ask every time").
CREATE TABLE connection_confirmation_restores (
  connector_id TEXT PRIMARY KEY REFERENCES connectors(id),
  installation_id TEXT NOT NULL REFERENCES plugin_installations(id),
  -- The connector revision right after migration 0090 (or at this queueing for rows that
  -- were already migrated); any later change to the connection makes the check keep the mode.
  migrated_revision INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','restored','kept','failed'))
);
CREATE INDEX connection_confirmation_restores_pending
  ON connection_confirmation_restores(state, connector_id);

-- Installations migration 0090 has not processed yet are queued by that migration itself.
-- A user who set any confirmation mode afterwards left an audited `confirmation_*` change; those
-- connections are never queued.
INSERT OR IGNORE INTO connection_confirmation_restores(connector_id, installation_id, migrated_revision)
SELECT c.id, c.plugin_installation_id, c.revision
FROM connectors c
JOIN connection_access_migrations m ON m.installation_id = c.plugin_installation_id
WHERE m.mode = 'ask_first' AND m.state = 'migrated'
  AND c.removed_at IS NULL AND c.confirmation_mode = 'always_ask'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log a
    WHERE a.kind = 'connector.changed'
      AND json_extract(a.detail, '$.connectorId') = c.id
      AND json_extract(a.detail, '$.reasonCode') LIKE 'confirmation\_%' ESCAPE '\'
  );
