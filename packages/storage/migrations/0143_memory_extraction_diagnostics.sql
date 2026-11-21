-- Counts contain no conversation or memory text. Existing rows keep zero (unknown historical counts).
ALTER TABLE memory_extractions ADD COLUMN raw_candidates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_extractions ADD COLUMN valid_candidates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_extractions ADD COLUMN applied_candidates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_extractions ADD COLUMN proposed_candidates INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_extractions ADD COLUMN reason_counts TEXT NOT NULL DEFAULT '{}';
CREATE INDEX memory_extractions_started ON memory_extractions(started_at, bot_id);
