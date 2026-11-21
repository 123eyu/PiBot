-- A routine may run a workflow skill ({skillId, params, inputs} JSON) instead of free text.
-- Added as a column (no rebuild); NULL is a free-text routine as before.
ALTER TABLE routines ADD COLUMN workflow TEXT CHECK (workflow IS NULL OR json_valid(workflow));
