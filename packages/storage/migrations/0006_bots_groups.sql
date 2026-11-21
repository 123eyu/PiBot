-- Preserve messages and their rowids, attachments, tools, approvals and legacy session paths.
ALTER TABLE bots ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE bots ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'auto' CHECK(memory_mode IN ('auto','ask'));
ALTER TABLE bots ADD COLUMN archived_at TEXT;
CREATE TRIGGER bots_protect_main_update BEFORE UPDATE OF is_main, archived_at ON bots
WHEN OLD.is_main = 1 AND (NEW.is_main <> 1 OR NEW.archived_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Cannot archive or demote main Bot'); END;
CREATE TRIGGER bots_protect_main_delete BEFORE DELETE ON bots WHEN OLD.is_main = 1
BEGIN SELECT RAISE(ABORT, 'Cannot delete main Bot'); END;

CREATE TABLE groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, coordinator_bot_id TEXT NOT NULL REFERENCES bots(id),
  announcement TEXT NOT NULL DEFAULT '', auto_round_limit INTEGER NOT NULL DEFAULT 4 CHECK(auto_round_limit BETWEEN 1 AND 10),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), workplace TEXT NOT NULL DEFAULT '{"kind":"coordinator"}' CHECK(json_valid(workplace)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(id, coordinator_bot_id) REFERENCES group_members(group_id,bot_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id), position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 5), joined_at TEXT NOT NULL, left_at TEXT,
  PRIMARY KEY(group_id, bot_id)
);
PRAGMA defer_foreign_keys = ON;
CREATE TABLE conversations_new (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('dm','group','thread')),
  bot_id TEXT REFERENCES bots(id), pi_session_file TEXT,
  group_id TEXT REFERENCES groups(id), thread_of TEXT REFERENCES conversations(id),
  title TEXT NOT NULL DEFAULT '', archived_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK((kind='dm' AND bot_id IS NOT NULL AND group_id IS NULL AND thread_of IS NULL) OR
        (kind='group' AND bot_id IS NULL AND group_id IS NOT NULL AND thread_of IS NULL) OR
        (kind='thread' AND bot_id IS NULL AND group_id IS NOT NULL AND thread_of IS NOT NULL))
);
INSERT INTO conversations_new(id,kind,bot_id,pi_session_file,created_at,updated_at)
SELECT id,kind,bot_id,pi_session_file,created_at,updated_at FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX conversations_bot_id ON conversations(bot_id);
CREATE INDEX conversations_group_id ON conversations(group_id,created_at);
CREATE UNIQUE INDEX conversations_one_group ON conversations(group_id) WHERE kind='group';
-- SQLite retains deferred DROP counters after the parent is restored; check actual FKs first.
CREATE TEMP TABLE migration_fk_guard (violations INTEGER CHECK(violations=0));
INSERT INTO migration_fk_guard SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE migration_fk_guard;
PRAGMA defer_foreign_keys = OFF;

ALTER TABLE messages ADD COLUMN bot_id TEXT REFERENCES bots(id);
ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(mentions) AND json_type(mentions)='array');
UPDATE messages SET bot_id=(SELECT bot_id FROM conversations WHERE id=messages.conversation_id) WHERE role<>'user';
CREATE TABLE bot_sessions (
  bot_id TEXT NOT NULL REFERENCES bots(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), pi_session_file TEXT NOT NULL,
  PRIMARY KEY(bot_id,conversation_id)
);
INSERT INTO bot_sessions SELECT bot_id,id,pi_session_file FROM conversations WHERE pi_session_file IS NOT NULL;
CREATE TABLE group_tasks (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  thread_conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id), assignee_bot_id TEXT NOT NULL,
  title TEXT NOT NULL, instructions TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')),
  summary TEXT, created_by_bot_id TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT,
  FOREIGN KEY(group_id,assignee_bot_id) REFERENCES group_members(group_id,bot_id),
  FOREIGN KEY(group_id,created_by_bot_id) REFERENCES group_members(group_id,bot_id),
  CHECK((status='open' AND finished_at IS NULL) OR (status<>'open' AND finished_at IS NOT NULL))
);
CREATE INDEX group_tasks_page ON group_tasks(group_id,created_at,id);
CREATE TABLE memories (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), text TEXT NOT NULL CHECK(length(trim(text))>0 AND length(text)<=8000 AND instr(text,char(0))=0),
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX memories_bot ON memories(bot_id,created_at,id);
CREATE TABLE memory_proposals (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), text TEXT NOT NULL CHECK(length(trim(text))>0 AND length(text)<=8000 AND instr(text,char(0))=0),
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL, action TEXT NOT NULL DEFAULT 'add' CHECK(action IN ('add','update','remove')), memory_id TEXT, resolved_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')), created_at TEXT NOT NULL
);
CREATE INDEX memory_proposals_bot_status ON memory_proposals(bot_id,status,created_at,id);
CREATE TABLE sidebar_groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0), collapsed INTEGER NOT NULL DEFAULT 0 CHECK(collapsed IN(0,1)), created_at TEXT NOT NULL
);
CREATE TABLE sidebar_entries (
  conversation_key TEXT PRIMARY KEY, bot_id TEXT UNIQUE REFERENCES bots(id), chat_group_id TEXT UNIQUE REFERENCES groups(id),
  pinned_at TEXT, group_id TEXT REFERENCES sidebar_groups(id) ON DELETE SET NULL, hidden_at TEXT,
  unread INTEGER NOT NULL DEFAULT 0 CHECK(unread IN(0,1)), last_read_at TEXT,
  CHECK((bot_id IS NOT NULL AND chat_group_id IS NULL AND conversation_key='dm:'||bot_id) OR
        (bot_id IS NULL AND chat_group_id IS NOT NULL AND conversation_key='group:'||chat_group_id))
);
CREATE TRIGGER sidebar_protect_main_insert BEFORE INSERT ON sidebar_entries
WHEN NEW.hidden_at IS NOT NULL AND EXISTS(SELECT 1 FROM bots WHERE id=NEW.bot_id AND is_main=1)
BEGIN SELECT RAISE(ABORT,'Cannot hide main Bot'); END;
CREATE TRIGGER sidebar_protect_main_update BEFORE UPDATE ON sidebar_entries
WHEN NEW.hidden_at IS NOT NULL AND EXISTS(SELECT 1 FROM bots WHERE id=NEW.bot_id AND is_main=1)
BEGIN SELECT RAISE(ABORT,'Cannot hide main Bot'); END;
INSERT INTO sidebar_entries(conversation_key,bot_id) SELECT 'dm:'||id,id FROM bots;
CREATE INDEX sidebar_entries_group ON sidebar_entries(group_id);
CREATE INDEX group_members_bot ON group_members(bot_id);
CREATE INDEX bot_sessions_conversation ON bot_sessions(conversation_id);

CREATE TRIGGER memories_quota_insert BEFORE INSERT ON memories
WHEN (SELECT COUNT(*) FROM memories WHERE bot_id=NEW.bot_id)>=100 OR
 (SELECT COALESCE(SUM(length(text)),0) FROM memories WHERE bot_id=NEW.bot_id)+length(NEW.text)>8000
BEGIN SELECT RAISE(ABORT,'Memory quota exceeded'); END;
CREATE TRIGGER memories_quota_update BEFORE UPDATE OF text,bot_id ON memories
WHEN (SELECT COUNT(*) FROM memories WHERE bot_id=NEW.bot_id AND id<>OLD.id)>=100 OR
 (SELECT COALESCE(SUM(length(text)),0) FROM memories WHERE bot_id=NEW.bot_id AND id<>OLD.id)+length(NEW.text)>8000
BEGIN SELECT RAISE(ABORT,'Memory quota exceeded'); END;
CREATE TRIGGER conversations_thread_parent_insert BEFORE INSERT ON conversations
WHEN NEW.kind='thread' AND NOT EXISTS(SELECT 1 FROM conversations WHERE id=NEW.thread_of AND kind='group' AND group_id=NEW.group_id)
BEGIN SELECT RAISE(ABORT,'Wrong thread parent'); END;
CREATE TRIGGER group_tasks_thread_insert BEFORE INSERT ON group_tasks
WHEN NOT EXISTS(SELECT 1 FROM conversations WHERE id=NEW.thread_conversation_id AND kind='thread' AND group_id=NEW.group_id)
BEGIN SELECT RAISE(ABORT,'Wrong task thread'); END;

ALTER TABLE attachments ADD COLUMN owner_bot_id TEXT REFERENCES bots(id);
UPDATE attachments SET owner_bot_id=(SELECT c.bot_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=attachments.message_id);
CREATE INDEX attachments_owner_bot ON attachments(owner_bot_id);

CREATE UNIQUE INDEX group_members_active_position ON group_members(group_id,position) WHERE left_at IS NULL;
CREATE TRIGGER group_members_protect_coordinator BEFORE UPDATE OF left_at ON group_members
WHEN NEW.left_at IS NOT NULL AND EXISTS(SELECT 1 FROM groups WHERE id=NEW.group_id AND coordinator_bot_id=NEW.bot_id)
BEGIN SELECT RAISE(ABORT,'Cannot remove coordinator'); END;

CREATE TRIGGER bots_one_main_insert BEFORE INSERT ON bots
WHEN NEW.is_main=1 AND EXISTS(SELECT 1 FROM bots WHERE is_main=1)
BEGIN SELECT RAISE(ABORT,'Main Bot already exists'); END;
CREATE TRIGGER bots_one_main_update BEFORE UPDATE OF is_main ON bots
WHEN NEW.is_main=1 AND OLD.is_main<>1 AND EXISTS(SELECT 1 FROM bots WHERE is_main=1)
BEGIN SELECT RAISE(ABORT,'Main Bot already exists'); END;
