ALTER TABLE groups ADD COLUMN external_agent_step_context INTEGER NOT NULL DEFAULT 1 CHECK(external_agent_step_context IN (0,1));
