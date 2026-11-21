-- A note may carry why it was saved and how to apply it. Both stay out of the injected
-- text; the catalog never shows them and memory_read returns them. NULL keeps old rows unchanged.
ALTER TABLE scoped_memories ADD COLUMN why TEXT;
ALTER TABLE scoped_memories ADD COLUMN how TEXT;
-- A proposal carries the same two fields, so asking mode does not silently drop them on accept.
ALTER TABLE scoped_memory_proposals ADD COLUMN why TEXT;
ALTER TABLE scoped_memory_proposals ADD COLUMN how TEXT;
