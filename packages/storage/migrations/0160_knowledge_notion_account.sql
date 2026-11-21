-- The Notion account a knowledge source is signed in as — workspace name, owner name and email,
-- read with Notion's own `notion-get-self` tool so the person can see which account is connected.
-- NULL until the first read. Never a token or an id; the JSON is validated on read.
ALTER TABLE knowledge_sources ADD COLUMN account_json TEXT;
