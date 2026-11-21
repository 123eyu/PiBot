-- Retain the opaque, brain-owned source path needed to re-read brought-over MCPs.
-- It never crosses the renderer and is only used after the user explicitly asks for an update.
ALTER TABLE plugin_installations ADD COLUMN origin_path TEXT;
