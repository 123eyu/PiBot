-- Users no longer pick workflows, so a routine bound to a workflow skill becomes "plan
-- from this request each run". Turning a binding into request text needs the skill's name and
-- contract budget from its files, so each such routine is queued here and the routines capability
-- settles it once at start, row by row: a routine bound to a plan saved from a passed dynamic plan
-- keeps that binding; every other gets its request and budget; a row
-- that cannot be settled is disabled with its binding intact. Every outcome is audited.
ALTER TABLE routines ADD COLUMN budget TEXT CHECK (budget IS NULL OR json_valid(budget));

CREATE TABLE IF NOT EXISTS routine_workflow_retirements (
  routine_id TEXT PRIMARY KEY REFERENCES routines(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('workflow','saved_plan')),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','planned','kept','skipped','failed')),
  reason TEXT CHECK(reason IS NULL OR length(reason) <= 80),
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS routine_workflow_retirements_pending
  ON routine_workflow_retirements(routine_id) WHERE state='pending';

INSERT OR IGNORE INTO routine_workflow_retirements(routine_id, skill_id, kind)
SELECT r.id, json_extract(r.workflow, '$.skillId'),
  CASE WHEN EXISTS (
    SELECT 1 FROM skills s
    WHERE s.id = json_extract(r.workflow, '$.skillId') AND s.bot_id = r.bot_id
      AND s.saved_plan_run_id IS NOT NULL
  ) THEN 'saved_plan' ELSE 'workflow' END
FROM routines r
WHERE r.workflow IS NOT NULL AND r.deleted_at IS NULL
  AND json_type(r.workflow, '$.skillId') = 'text';
