-- A copy job whose target can never become valid again (deleted or archived Bot, a
-- deleted or empty group, a member that has left or was archived) used to stay 'failed', so every
-- start retried it, audited it again and kept "some skills could not be copied" on screen. Such a
-- job now settles once: state 'done' keeps it out of every pending/retry query, the reason says
-- why no copy exists, and brain writes its single audit record (abandon_audited) after startup.
ALTER TABLE plugin_skill_copy_jobs ADD COLUMN abandoned_reason TEXT
  CHECK(abandoned_reason IS NULL OR abandoned_reason='target_unavailable');
ALTER TABLE plugin_skill_copy_jobs ADD COLUMN abandon_audited INTEGER NOT NULL DEFAULT 0
  CHECK(abandon_audited IN (0,1));

UPDATE plugin_skill_copy_jobs SET state='done',abandoned_reason='target_unavailable'
WHERE state<>'done' AND (
  (target_kind='bot' AND NOT EXISTS(
    SELECT 1 FROM bots b WHERE b.id=plugin_skill_copy_jobs.bot_id AND b.archived_at IS NULL))
  OR (target_kind='group' AND NOT EXISTS(
    SELECT 1 FROM groups g
    JOIN group_members m ON m.group_id=g.id AND m.left_at IS NULL
    JOIN bots b ON b.id=m.bot_id AND b.archived_at IS NULL
    WHERE g.id=plugin_skill_copy_jobs.target_id AND m.bot_id=plugin_skill_copy_jobs.bot_id))
);

-- A re-import is a new installation of the same plugin. Its copy for a target that already holds
-- this skill reuses that copy; when the package content differs, the newer hash is kept here so
-- the UI can say "update available" instead of creating a second "X (2)" skill.
ALTER TABLE plugin_skill_copies ADD COLUMN available_hash TEXT;
CREATE INDEX IF NOT EXISTS plugin_skill_copies_target
  ON plugin_skill_copies(skill_path,target_kind,target_id,bot_id,created_at);
