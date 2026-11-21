-- Google compatibility mode: a per-Bot switch for its own browser. NULL is off (the default
-- for every existing and new Bot); the value is when the user turned it on.
ALTER TABLE bots ADD COLUMN google_compat_at TEXT;
