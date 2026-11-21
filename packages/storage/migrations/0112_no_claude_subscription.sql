-- No decryption is needed to retire a credential namespace. Preserve ordinary API keys.
INSERT OR IGNORE INTO providers(id,kind,config,created_at,updated_at)
SELECT 'anthropic','builtin','{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (SELECT 1 FROM secrets WHERE scope='provider:anthropic:oauth');

UPDATE providers SET config=json_set(
  json_remove(config,'$.authState','$.authError'),
  '$.selectedAuth','apiKey','$.subscriptionRemoved',json('true'))
WHERE id='anthropic' AND (json_extract(config,'$.selectedAuth')='oauth'
  OR EXISTS (SELECT 1 FROM secrets WHERE scope='provider:anthropic:oauth'));

-- An API-key user may still have a stale subscription inbox state from an earlier switch.
UPDATE providers SET config=json_remove(config,'$.authState','$.authError') WHERE id='anthropic';

DELETE FROM secrets WHERE scope='provider:anthropic:oauth';

INSERT OR IGNORE INTO audit_log(id,at,bot_id,kind,summary,detail,run_id)
SELECT '00570000-0000-4000-8000-000000000033',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  COALESCE((SELECT id FROM bots WHERE is_main=1 LIMIT 1),'00000000-0000-4000-8000-000000000000'),
  'oauth.changed','Claude subscription sign-in removed',
  '{"providerId":"anthropic","providerName":"Anthropic","authEvent":"oauth.subscription_removed"}',NULL
WHERE EXISTS (SELECT 1 FROM providers WHERE id='anthropic' AND json_extract(config,'$.subscriptionRemoved')=1);
