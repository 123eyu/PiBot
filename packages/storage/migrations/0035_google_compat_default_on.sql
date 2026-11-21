-- Google compatibility mode is on by default (maintainers, 2026-10-15). New Bots get it when they
-- are created (BotsRepo); this turns it on once for every existing Bot that has it off. A user who
-- turns it off afterwards keeps it off: the migration does not run again.
UPDATE bots SET google_compat_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE google_compat_at IS NULL;
