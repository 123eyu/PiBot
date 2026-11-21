-- Destination CAS must survive deletion of the source proposal and its cascading move link.
ALTER TABLE scoped_memory_proposals ADD COLUMN scope_move_target_before_json TEXT;
UPDATE scoped_memory_proposals AS p
SET scope_move_target_before_json=(
  SELECT target_before_json FROM memory_scope_moves WHERE target_proposal_id=p.id
)
WHERE EXISTS (
  SELECT 1 FROM memory_scope_moves WHERE target_proposal_id=p.id AND target_before_json IS NOT NULL
);
CREATE INDEX memory_scope_moves_source ON memory_scope_moves(source_id);

-- All deletion paths (management, tools and clear) settle destinations in the deleting transaction.
CREATE TRIGGER memory_move_source_deleted BEFORE DELETE ON scoped_memories BEGIN
  UPDATE scoped_memory_proposals SET status='rejected'
  WHERE status='pending' AND id IN (
    SELECT target_proposal_id FROM memory_scope_moves WHERE source_id=OLD.id
  );
END;

CREATE TRIGGER memory_move_removal_deleted BEFORE DELETE ON scoped_memory_proposals BEGIN
  UPDATE scoped_memory_proposals SET status='rejected'
  WHERE status='pending' AND id IN (
    SELECT target_proposal_id FROM memory_scope_moves WHERE removal_id=OLD.id
  );
END;
