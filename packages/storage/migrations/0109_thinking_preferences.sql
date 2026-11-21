ALTER TABLE bots ADD COLUMN thinking_preference TEXT
  CHECK (thinking_preference IS NULL OR thinking_preference IN ('off','low','medium','high'));

-- Old records do not distinguish automatic off from an explicit choice. Preserve uncertainty.
UPDATE bots SET thinking_preference=thinking_level
WHERE category='image' OR thinking_level<>'off' OR created_at<>updated_at
   OR model_provider IS NOT NULL OR role_id IS NOT NULL
   OR EXISTS (SELECT 1 FROM audit_log WHERE bot_id=bots.id AND kind='bot.updated');

-- Global settings have no trustworthy per-field edit history.
UPDATE settings SET value=json_set(value,'$.thinkingPreference',json_extract(value,'$.thinkingLevel'))
WHERE key='defaultModel' AND json_type(value)='object'
  AND json_type(value,'$.thinkingPreference') IS NULL;
