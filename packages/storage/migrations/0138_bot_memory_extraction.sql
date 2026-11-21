-- Post-hoc extraction is opt-out per Bot. Default on keeps existing Bots unchanged.
ALTER TABLE bots ADD COLUMN memory_extraction INTEGER NOT NULL DEFAULT 1 CHECK(memory_extraction IN (0,1));
