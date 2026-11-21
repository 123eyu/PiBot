-- A connection's recent use is read from the audit log by connection, newest first.
-- Raw connector calls record `connectorId`; connector adapter reads only carry it inside
-- `toolId` (`mcp:<connector id>:<digest>`), so the key falls back to that. Read-only index,
-- no new facts are written.
CREATE INDEX IF NOT EXISTS audit_log_connector_at ON audit_log(
  COALESCE(json_extract(detail, '$.connectorId'),
    CASE WHEN substr(json_extract(detail, '$.toolId'), 1, 4) = 'mcp:'
      THEN substr(json_extract(detail, '$.toolId'), 5, 36) END),
  at, id
) WHERE kind IN ('connector.called', 'policy.denied');
