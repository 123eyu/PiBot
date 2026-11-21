-- Built-in roles. role_id/role_version mark which built-in role (and its version) a Bot was
-- created from; NULL for every existing Bot and for Bots not made from a role. norms are the
-- working norms kept apart from the persona; quick_prompts is a JSON array of up to three starter
-- prompts (NULL = none). Nothing here grants anything.
ALTER TABLE bots ADD COLUMN role_id TEXT;
ALTER TABLE bots ADD COLUMN role_version INTEGER;
ALTER TABLE bots ADD COLUMN norms TEXT NOT NULL DEFAULT '';
ALTER TABLE bots ADD COLUMN quick_prompts TEXT;
