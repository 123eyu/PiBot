-- Role provenance was introduced in 0032; never infer it from names or persona text.
-- Audit and update share the migration transaction, including a rerun of this SQL.
CREATE TEMP TABLE builtin_thinking_low_candidates AS
SELECT id FROM bots
WHERE category = 'chat' AND is_main = 0 AND thinking_level = 'medium'
  AND role_version >= 1
  AND role_id IN (
    'general-assistant', 'ui-ux-designer', 'product-manager', 'project-manager',
    'researcher', 'data-analyst', 'copywriter', 'social-media', 'video-scriptwriter',
    'personal-assistant', 'recruiter', 'translator', 'tech-writer'
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_log
    WHERE bot_id = bots.id AND kind = 'bot.updated'
      AND json_extract(detail, '$.reasonCode') = 'builtin_thinking_low'
  );

INSERT INTO audit_log(id, at, bot_id, kind, summary, detail, run_id)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
             substr(hex(randomblob(2)), 2) || '-8' || substr(hex(randomblob(2)), 2) ||
             '-' || hex(randomblob(6))),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), id, 'bot.updated',
       'Built-in role thinking level adjusted / 内置角色思考强度已调整',
       json_object('actor', 'system', 'reasonCode', 'builtin_thinking_low'), NULL
FROM builtin_thinking_low_candidates;

UPDATE bots SET thinking_level = 'low'
WHERE id IN (SELECT id FROM builtin_thinking_low_candidates);

DROP TABLE builtin_thinking_low_candidates;
