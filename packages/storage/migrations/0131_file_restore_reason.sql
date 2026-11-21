-- Preserve fixed filesystem failures across restart without persisting native error text.
ALTER TABLE file_restore_items ADD COLUMN reason TEXT
  CHECK(reason IS NULL OR reason IN ('file_changed','unsafe_path','recovery_interrupted','file_in_use'));
