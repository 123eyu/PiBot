-- Built-in methods have independent identities; user/team copies remain untouched.
ALTER TABLE skills ADD COLUMN builtin_key TEXT;
ALTER TABLE skills ADD COLUMN builtin_digest TEXT;
ALTER TABLE group_member_skills ADD COLUMN builtin_key TEXT;
ALTER TABLE group_member_skills ADD COLUMN builtin_digest TEXT;
CREATE UNIQUE INDEX skills_builtin_key ON skills(bot_id,builtin_key) WHERE builtin_key IS NOT NULL;
CREATE UNIQUE INDEX group_skills_builtin_key ON group_member_skills(group_id,bot_id,builtin_key) WHERE builtin_key IS NOT NULL;

INSERT INTO audit_log(id,at,bot_id,kind,summary,detail,run_id)
SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
       strftime('%Y-%m-%dT%H:%M:%fZ','now'),b.id,'connector.changed',
       'Built-in research methods moved to roles / 研究方法已移入角色',
       json_object('installationId',p.id,'reasonCode','builtin_methods_migrated'),NULL
FROM plugin_installations p JOIN bots b ON b.is_main=1
WHERE p.source_kind='builtin' AND p.plugin_id='pibot.research-methods' AND p.status<>'removed';
UPDATE plugin_access SET mode='selected',bots_json='[]',groups_json='[]'
WHERE installation_id IN (SELECT id FROM plugin_installations WHERE source_kind='builtin' AND plugin_id='pibot.research-methods');
UPDATE plugin_installations SET enabled=0,status='removed',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE source_kind='builtin' AND plugin_id='pibot.research-methods' AND status<>'removed';
