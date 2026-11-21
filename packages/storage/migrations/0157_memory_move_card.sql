-- One visible move proposal keeps the old destination proposal as an internal dependency.
-- The stored action stays 'remove' (CHECK allows add/update/remove); a removal with
-- move_target_bot_id is read back as a move card.
ALTER TABLE scoped_memory_proposals ADD COLUMN move_target_bot_id TEXT;
ALTER TABLE scoped_memory_proposals ADD COLUMN move_target_memory_id TEXT;
ALTER TABLE scoped_memory_proposals ADD COLUMN move_target_text TEXT;
ALTER TABLE scoped_memory_proposals ADD COLUMN move_target_why TEXT;
ALTER TABLE scoped_memory_proposals ADD COLUMN move_target_how TEXT;
-- Pending moves made by the earlier two-card flow become the same single card (idempotent:
-- only rows without a move target change); accepted ones keep their original lifecycle.
UPDATE scoped_memory_proposals SET
  move_target_bot_id = (SELECT m.target_bot_id FROM memory_scope_moves m WHERE m.removal_id = scoped_memory_proposals.id),
  move_target_memory_id = (SELECT m.target_memory_id FROM memory_scope_moves m WHERE m.removal_id = scoped_memory_proposals.id),
  move_target_text = (SELECT json_extract(m.copy_json, '$.text') FROM memory_scope_moves m WHERE m.removal_id = scoped_memory_proposals.id),
  move_target_why = (SELECT json_extract(m.copy_json, '$.why') FROM memory_scope_moves m WHERE m.removal_id = scoped_memory_proposals.id),
  move_target_how = (SELECT json_extract(m.copy_json, '$.how') FROM memory_scope_moves m WHERE m.removal_id = scoped_memory_proposals.id)
WHERE action = 'remove' AND status = 'pending' AND move_target_bot_id IS NULL
  AND id IN (SELECT removal_id FROM memory_scope_moves);
