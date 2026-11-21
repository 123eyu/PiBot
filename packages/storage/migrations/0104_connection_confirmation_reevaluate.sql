-- The first-use restore kept a connection on "ask every time" unless it found a
-- remembered grant, a routine pre-authorization or trigger. A connection still on "ask first" at
-- migration 0090 had never been granted through that question, so connections nobody
-- touched (the owner's local calendar) stayed `kept`. The check now restores every connection
-- the user has not edited since that migration to the new-connection default.
-- Each `kept` row whose connection is still exactly "ask every time" is checked once more at the
-- next start; the check itself keeps the ones the user edited (their own "ask every time" stays).
-- Running it again changes nothing: requeued rows are `pending`, not `kept`.
UPDATE connection_confirmation_restores SET state='pending'
WHERE state='kept'
  AND EXISTS (
    SELECT 1 FROM connectors c
    WHERE c.id = connection_confirmation_restores.connector_id
      AND c.removed_at IS NULL AND c.confirmation_mode = 'always_ask'
  );
