-- Attachment files (`attachments.path` / `text_path`) are stored relative to the data directory
-- (`bots/<botId>/attachments/<file>`) so a moved, restored or symlinked data directory keeps chat
-- attachments, generated images and their `.thumb` previews. Same rule as 0022 for session files:
-- attachment files always live in the fixed `<dataDir>/bots/<owner>/attachments/` folder, so an old
-- absolute path is recognised by that suffix (with the row's own owning Bot), whatever data
-- directory it was written under; `\` separators from Windows are normalised first. Rows that do
-- not end in exactly that structure keep their value, and readers still reject them unless they
-- point into the current data directory's attachments folder.
-- Idempotent: converted values no longer start with a separator or drive and are skipped.

WITH owned AS (
  SELECT a.id, replace(a.path,'\','/') AS p,
    '/bots/'||COALESCE(a.owner_bot_id,m.bot_id,c.bot_id)||'/attachments/' AS marker,
    COALESCE(a.owner_bot_id,m.bot_id,c.bot_id) AS bot
  FROM attachments a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id
  WHERE (substr(a.path,1,1) IN ('/','\') OR substr(a.path,2,1)=':') AND COALESCE(a.owner_bot_id,m.bot_id,c.bot_id) IS NOT NULL
), split AS (
  SELECT id, bot, instr(p,marker) AS at, substr(p,instr(p,marker)+length(marker)) AS file FROM owned
)
UPDATE attachments SET path='bots/'||split.bot||'/attachments/'||split.file
FROM split
WHERE attachments.id=split.id AND split.at>0 AND split.file<>'' AND split.file NOT IN ('.','..') AND instr(split.file,'/')=0;

WITH owned AS (
  SELECT a.id, replace(a.text_path,'\','/') AS p,
    '/bots/'||COALESCE(a.owner_bot_id,m.bot_id,c.bot_id)||'/attachments/' AS marker,
    COALESCE(a.owner_bot_id,m.bot_id,c.bot_id) AS bot
  FROM attachments a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id
  WHERE a.text_path IS NOT NULL AND (substr(a.text_path,1,1) IN ('/','\') OR substr(a.text_path,2,1)=':') AND COALESCE(a.owner_bot_id,m.bot_id,c.bot_id) IS NOT NULL
), split AS (
  SELECT id, bot, instr(p,marker) AS at, substr(p,instr(p,marker)+length(marker)) AS file FROM owned
)
UPDATE attachments SET text_path='bots/'||split.bot||'/attachments/'||split.file
FROM split
WHERE attachments.id=split.id AND split.at>0 AND split.file<>'' AND split.file NOT IN ('.','..') AND instr(split.file,'/')=0;
