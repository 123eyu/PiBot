-- A scheduled run marks itself as needing the user (routine_flag_attention tool, maintainers 2026-10-21),
-- replacing a regex guess over the summary for "notify only when it needs me". Nullable: no mark.
-- A future rebuild of routine_runs must keep this column (and drop/recreate the 0065 views).
ALTER TABLE routine_runs ADD COLUMN attention_reason TEXT CHECK (attention_reason IS NULL OR length(attention_reason) BETWEEN 1 AND 200);
