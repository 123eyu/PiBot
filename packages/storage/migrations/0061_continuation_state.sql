-- Phase 3: automatic continuation state survives a restart. Rows hold ids, fingerprints
-- and counters only; prompts, results and context are never copied here. No foreign keys on
-- purpose: a pruned run or task must drop its intent with it, which the restore path decides, not
-- SQLite's cascade timing.
CREATE TABLE IF NOT EXISTS continuation_ledgers (
  root_run_id TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0 CHECK(used >= 0),
  idle_todo INTEGER NOT NULL DEFAULT 0 CHECK(idle_todo >= 0),
  idle_parent INTEGER NOT NULL DEFAULT 0 CHECK(idle_parent >= 0),
  idle_summary INTEGER NOT NULL DEFAULT 0 CHECK(idle_summary >= 0),
  updated_at TEXT NOT NULL
);

-- One row per restorable continuation: a parent resume, a pending result summary, or a parallel
-- mission workspace waiting for integration. `subject_id` separates worktree rows that share a
-- root; parent and summary intents keep it empty so each root has at most one of each.
CREATE TABLE IF NOT EXISTS continuation_intents (
  id TEXT PRIMARY KEY,
  root_run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('parent','summary','worktree')),
  subject_id TEXT NOT NULL DEFAULT '',
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  run_id TEXT,
  authority_ref TEXT,
  plan_version INTEGER,
  plan_fingerprint TEXT,
  progress INTEGER,
  trigger_id TEXT,
  group_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS continuation_intents_identity
  ON continuation_intents(root_run_id,kind,subject_id);
CREATE INDEX IF NOT EXISTS continuation_intents_topic
  ON continuation_intents(conversation_id,created_at,id);
