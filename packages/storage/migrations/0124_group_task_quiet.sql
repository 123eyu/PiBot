-- A direct request that ended as plain chat closes its task quietly instead of listing it as
-- progress in the group; the timestamp keeps that closure distinct from a real completion.
ALTER TABLE group_tasks ADD COLUMN quiet_at TEXT;
