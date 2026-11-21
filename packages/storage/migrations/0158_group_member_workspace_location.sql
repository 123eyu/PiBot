-- A parallel member's worktree may live on a runner; NULL keeps the existing local rows.
ALTER TABLE group_member_workspaces ADD COLUMN execution_location TEXT;
