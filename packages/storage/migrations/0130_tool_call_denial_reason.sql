-- A step refused without a card keeps the policy reason code, so the chat row can name the
-- reason (only the code, never a path or message). Old rows stay NULL and display as before.
ALTER TABLE tool_calls ADD COLUMN denial_reason TEXT;
