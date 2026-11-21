-- Retire only the old Codex OAuth namespace before any runtime consumer starts.
INSERT OR IGNORE INTO providers(id,kind,config,created_at,updated_at)
SELECT 'openai-codex','builtin','{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (SELECT 1 FROM secrets WHERE scope='provider:openai-codex:oauth');

UPDATE providers SET config=json_set(
  json_remove(config,'$.authState','$.authError'),
  '$.selectedAuth','apiKey','$.subscriptionRemoved',json('true'))
WHERE id='openai-codex' AND (json_extract(config,'$.selectedAuth')='oauth'
  OR EXISTS (SELECT 1 FROM secrets WHERE scope='provider:openai-codex:oauth'));

UPDATE providers SET config=json_remove(config,'$.authState','$.authError') WHERE id='openai-codex';
DELETE FROM secrets WHERE scope='provider:openai-codex:oauth';

-- Carry only the notice forward; the official flow must issue its own new credentials.
INSERT OR IGNORE INTO providers(id,kind,config,created_at,updated_at)
SELECT 'openai','builtin','{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (SELECT 1 FROM providers WHERE id='openai-codex' AND json_extract(config,'$.subscriptionRemoved')=1);

UPDATE providers SET config=json_set(config,'$.subscriptionRemoved',json('true'))
WHERE id='openai' AND EXISTS (SELECT 1 FROM providers WHERE id='openai-codex' AND json_extract(config,'$.subscriptionRemoved')=1);

INSERT OR IGNORE INTO audit_log(id,at,bot_id,kind,summary,detail,run_id)
SELECT '00580000-0000-4000-8000-000000000001',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  COALESCE((SELECT id FROM bots WHERE is_main=1 LIMIT 1),'00000000-0000-4000-8000-000000000000'),
  'oauth.changed','Legacy ChatGPT subscription sign-in removed',
  '{"providerId":"openai-codex","providerName":"ChatGPT","authEvent":"oauth.chatgpt_migrated"}',NULL
WHERE EXISTS (SELECT 1 FROM providers WHERE id='openai-codex' AND json_extract(config,'$.subscriptionRemoved')=1);
