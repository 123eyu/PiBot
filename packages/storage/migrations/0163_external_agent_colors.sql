-- An external agent Bot's theme colour follows its logo (Claude orange; Codex, Cursor and
-- OpenCode black). Bots created before this rule got a random colour; custom agents keep theirs.
UPDATE bots SET avatar_color = 'orange'
WHERE id IN (SELECT bot_id FROM external_agent_bots WHERE agent_id = 'claude');
UPDATE bots SET avatar_color = 'ink'
WHERE id IN (SELECT bot_id FROM external_agent_bots WHERE agent_id IN ('codex', 'cursor', 'opencode'));
