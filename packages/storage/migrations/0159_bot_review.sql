-- Which Bot reviews this Bot's code (NULL = recommend one) and whether a turn that changed
-- files asks for a read-only review automatically. Nothing here grants anything: the review run
-- keeps the author's read-only review scope; only its model and persona come from the reviewer.
ALTER TABLE bots ADD COLUMN review_bot_id TEXT;
ALTER TABLE bots ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 0 CHECK (auto_review IN (0, 1));
