-- Provenance of a group workflow saved from a passed dynamic plan (the plan's run id).
-- Written only by the save path after the brain checked that run; imports and copies leave it
-- NULL, so 「常用计划」 lists exactly the plans saved from a group's own runs. Both skill tables
-- share one column list; private skills always keep NULL.
ALTER TABLE skills ADD COLUMN saved_plan_run_id TEXT;
ALTER TABLE group_member_skills ADD COLUMN saved_plan_run_id TEXT;
