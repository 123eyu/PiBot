-- The first restore check (0094) treated any `connectors.revision` change since
-- queueing as a user change, but connector start and status / tool-list refreshes also advance
-- it, so connections nobody touched were marked `kept`. The check now reads the audited user
-- change instead (`migrated_revision` is no longer used for the decision). Each `kept` row whose
-- connection is still exactly "ask every time" and has no user `confirmation_*` change since the
-- installation's migration 0090 is checked once more at the next start. Running it again
-- changes nothing: requeued rows are `pending`, not `kept`.
UPDATE connection_confirmation_restores SET state='pending'
WHERE state='kept'
  AND EXISTS (
    SELECT 1 FROM connectors c
    WHERE c.id = connection_confirmation_restores.connector_id
      AND c.removed_at IS NULL AND c.confirmation_mode = 'always_ask'
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_log a
    WHERE a.kind = 'connector.changed'
      AND json_extract(a.detail, '$.connectorId') = connection_confirmation_restores.connector_id
      AND json_extract(a.detail, '$.reasonCode') IN
        ('confirmation_read_write', 'confirmation_always_ask', 'confirmation_read_only')
      AND a.at >= COALESCE((
        SELECT max(m.at) FROM audit_log m
        WHERE m.kind = 'connector.changed'
          AND json_extract(m.detail, '$.installationId') = connection_confirmation_restores.installation_id
          AND json_extract(m.detail, '$.reasonCode') = 'connection_permissions_migrated'
      ), '')
  );
