-- pibot:step unique-bot-names
-- Bot names are unique among non-archived Bots (trimmed, NFKC, case-folded). SQLite cannot
-- fold Unicode, so the step named above (packages/storage/src/migration-steps.ts) renames later
-- duplicates by created_at to 「name 2」, 「name 3」… inside this migration's transaction. It changes
-- bots.name only; archived Bots are left as they are. No schema change.
SELECT 1;
