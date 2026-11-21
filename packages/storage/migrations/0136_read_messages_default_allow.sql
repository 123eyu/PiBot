-- The migration ledger marks this policy change once, in the same transaction as its audit.
-- Permission snapshots do not distinguish the old default from an explicit global choice.
UPDATE settings SET value=json_set(value,'$.levels.read_messages','always')
WHERE key='permissions' AND json_valid(value)
  AND json_extract(value,'$.levels.read_messages')='never';

-- Keep this directly after the UPDATE: audit only an actual change, with no settings payload.
INSERT INTO audit_log(id,at,bot_id,kind,summary,detail,run_id)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
             substr(hex(randomblob(2)),2) || '-8' || substr(hex(randomblob(2)),2) ||
             '-' || hex(randomblob(6))),
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       COALESCE((SELECT id FROM bots WHERE is_main=1 LIMIT 1),'00000000-0000-4000-8000-000000000000'),
       'permissions.changed',
       'Read messages now allowed by default / read_messages 默认改为允许',
       json_object('actor','system','reasonCode','read_messages_default_allowed'),NULL
WHERE changes()=1;
