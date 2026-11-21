-- An agent Bot's own settings for new topics (mode, model, reasoning
-- effort, speed and the agent's other select settings) and the options its agent last offered,
-- so the header and the Bot profile can show them before a topic has a session.
ALTER TABLE external_agent_bots ADD COLUMN options_json TEXT CHECK (options_json IS NULL OR json_valid(options_json));
ALTER TABLE external_agent_bots ADD COLUMN preferences_json TEXT CHECK (preferences_json IS NULL OR json_valid(preferences_json));
