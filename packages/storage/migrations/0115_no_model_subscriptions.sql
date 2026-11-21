-- Runs before model consumers start. Match credential records in model namespaces only; never decrypt retired credentials.
INSERT OR IGNORE INTO audit_log(id,at,bot_id,kind,summary,detail,run_id)
SELECT '00580000-0000-4000-8000-000000000004',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  COALESCE((SELECT id FROM bots WHERE is_main=1 LIMIT 1),'00000000-0000-4000-8000-000000000000'),
  'oauth.changed','Model subscription sign-in disabled',
  '{"providerId":"models","authEvent":"oauth.subscriptions_removed"}',NULL
WHERE EXISTS (SELECT 1 FROM secrets WHERE name='credential' AND scope LIKE 'provider:%:oauth')
  OR EXISTS (SELECT 1 FROM providers WHERE json_extract(config,'$.selectedAuth')='oauth');

INSERT OR IGNORE INTO providers(id,kind,config,created_at,updated_at)
SELECT DISTINCT substr(scope,10,length(scope)-15),'builtin','{}',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM secrets WHERE name='credential' AND scope LIKE 'provider:%:oauth' AND length(scope)>15;

UPDATE providers SET config=json_set(
  json_remove(config,'$.authState','$.authError','$.chatgptHostId'),
  '$.selectedAuth','apiKey','$.subscriptionRemoved',json('true'))
WHERE json_extract(config,'$.selectedAuth')='oauth'
  OR EXISTS (SELECT 1 FROM secrets WHERE name='credential' AND scope='provider:' || providers.id || ':oauth');

-- Stale inbox status and installation-only subscription metadata no longer have a consumer.
UPDATE providers SET config=json_remove(config,'$.authState','$.authError','$.chatgptHostId');
DELETE FROM secrets WHERE name='credential' AND scope LIKE 'provider:%:oauth';
