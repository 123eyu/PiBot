ALTER TABLE conversations ADD COLUMN acp_session INTEGER NOT NULL DEFAULT 0
  CHECK (acp_session IN (0, 1));

-- Only roots already marked session prove ACP provenance; ordinary user roots are not evidence.
UPDATE conversations SET acp_session=1
WHERE kind='dm' AND EXISTS (
  SELECT 1 FROM working_folders f
  WHERE f.bot_id=conversations.bot_id AND f.association='session'
    AND (f.id=conversations.workplace_folder_id OR EXISTS (
      SELECT 1 FROM topic_folders t
      WHERE t.conversation_id=conversations.id AND t.folder_id=f.id
    ))
);
