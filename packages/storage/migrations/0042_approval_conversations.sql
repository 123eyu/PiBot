ALTER TABLE approvals ADD COLUMN conversation_id TEXT REFERENCES conversations(id);
UPDATE approvals SET conversation_id=(SELECT conversation_id FROM messages WHERE id=approvals.message_id);

DROP INDEX approvals_bot_chat_pending;
-- Group members share a conversation, but retain their independent approval lanes.
CREATE UNIQUE INDEX approvals_bot_conversation_chat_pending ON approvals(bot_id,conversation_id)
  WHERE status='pending' AND source='chat';

-- The message is the authority, including internal child conversations and routine checkpoints.
CREATE TRIGGER approvals_conversation_insert BEFORE INSERT ON approvals BEGIN
  SELECT RAISE(ABORT,'Invalid approval conversation') WHERE NEW.conversation_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM messages m WHERE m.id=NEW.message_id AND m.conversation_id=NEW.conversation_id
      AND m.run_id=NEW.run_id AND m.bot_id=NEW.bot_id AND m.role<>'user'
  );
END;
CREATE TRIGGER approvals_conversation_update BEFORE UPDATE OF conversation_id,message_id,run_id,bot_id ON approvals BEGIN
  SELECT RAISE(ABORT,'Invalid approval conversation') WHERE NEW.conversation_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM messages m WHERE m.id=NEW.message_id AND m.conversation_id=NEW.conversation_id
      AND m.run_id=NEW.run_id AND m.bot_id=NEW.bot_id AND m.role<>'user'
  );
END;
