// A batch owns its imported rows, allowing atomic publication, rollback, and recovery.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type ImportStatus, ImportStatusSchema } from "@pibot/import-contract";
import { AuditRepo, transaction } from "@pibot/storage";
import { ImportFailure } from "./failure.ts";
import { ImportMemories } from "./memories.ts";
import { ImportPersonas } from "./personas.ts";
import { ImportProjects } from "./projects.ts";

type ImportedTopic = {
  title: string;
  createdAt: string;
  updatedAt: string;
};
type ImportedMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

type Terminal = Exclude<ImportStatus["state"], "running" | "undoing">;
type CleanupTarget = "failed" | "cancelled";
const DELETE_RECORDS = 128;
const DELETE_STEP = 8;
const DELETE_WORK_MS = 18;

export class ImportStore {
  private readonly audit: AuditRepo;
  readonly memories: ImportMemories;
  readonly personas: ImportPersonas;
  readonly projects: ImportProjects;

  constructor(
    private readonly db: DatabaseSync,
    redactor: ConstructorParameters<typeof AuditRepo>[1],
  ) {
    this.audit = new AuditRepo(db, redactor);
    this.memories = new ImportMemories(db, (text) => redactor.redact(text));
    this.personas = new ImportPersonas(db, (text) => redactor.redact(text));
    this.projects = new ImportProjects(db);
  }

  availableBot(botId: string) {
    return !!this.db.prepare("SELECT 1 FROM bots WHERE id=? AND archived_at IS NULL").get(botId);
  }

  get(id: string) {
    const row = this.db
      .prepare(`SELECT id AS importId, source,
        CASE cleanup_phase WHEN 'undoing' THEN 'undoing' WHEN 'discarding' THEN 'running'
          ELSE state END AS state, topics, messages, reason, cleanup_phase,
        removed_topics, removed_messages, added_memories,
        EXISTS(SELECT 1 FROM import_personas WHERE import_id=import_jobs.id) AS applied_persona,
        (SELECT state FROM import_project_files WHERE import_id=import_jobs.id) AS project_file
        FROM import_jobs WHERE id=?`)
      .get(id);
    if (!row) return undefined;
    const {
      removed_topics,
      removed_messages,
      added_memories,
      applied_persona,
      project_file,
      cleanup_phase,
      ...status
    } = row;
    return ImportStatusSchema.parse({
      ...status,
      ...(cleanup_phase ? { cleanup: cleanup_phase } : {}),
      ...(added_memories ? { memories: added_memories } : {}),
      ...(applied_persona ? { persona: true } : {}),
      ...(project_file === "pending" && status.state === "completed"
        ? { projectFile: "AGENTS.md" }
        : {}),
      ...(project_file === "kept" ? { keptProjectFile: "AGENTS.md" } : {}),
      ...(cleanup_phase || status.state === "undone"
        ? { removed: { topics: removed_topics, messages: removed_messages } }
        : {}),
    });
  }

  create(id: string, source: ImportStatus["source"], botId: string) {
    this.db
      .prepare("INSERT INTO import_jobs(id,source,bot_id,state) VALUES(?,?,?,'running')")
      .run(id, source, botId);
  }

  target(id: string) {
    return this.db.prepare("SELECT bot_id FROM import_jobs WHERE id=?").get(id)?.bot_id;
  }

  unfinished() {
    return this.db
      .prepare("SELECT id FROM import_jobs WHERE state='running' AND cleanup_phase IS NULL LIMIT 1")
      .get()?.id;
  }

  addTopic(batchId: string, botId: string, source: ImportStatus["source"], topic: ImportedTopic) {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO conversations
      (id, kind, bot_id, title, created_at, updated_at, import_id, import_source)
      VALUES (?, 'dm', ?, ?, ?, ?, ?, ?)`)
      .run(id, botId, topic.title, topic.createdAt, topic.updatedAt, batchId, source);
    return id;
  }

  addMessage(batchId: string, botId: string, conversationId: string, msg: ImportedMessage) {
    this.db
      .prepare(`INSERT INTO messages
      (id, conversation_id, role, content, status, bot_id, created_at, updated_at, import_id)
      VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?)`)
      .run(
        randomUUID(),
        conversationId,
        msg.role,
        msg.text,
        msg.role === "user" ? null : botId,
        msg.createdAt,
        msg.createdAt,
        batchId,
      );
  }

  page<T>(id: string, add: () => T, counts: Pick<ImportStatus, "topics" | "messages">) {
    return transaction(this.db, () => {
      const result = add();
      this.db
        .prepare("UPDATE import_jobs SET topics=?, messages=? WHERE id=?")
        .run(counts.topics, counts.messages, id);
      return result;
    });
  }

  complete<T>(id: string, apply: () => T) {
    return transaction(this.db, () => {
      const change = apply();
      return { change, status: this.finish(id, "completed", null) };
    });
  }

  beginUndo(id: string) {
    return transaction(this.db, () => {
      if (this.projects.hasDependents(id)) throw new ImportFailure("project");
      const changed = this.db
        .prepare(`UPDATE import_jobs SET cleanup_phase='undoing'
        WHERE id=? AND state='completed' AND cleanup_phase IS NULL`)
        .run(id);
      if (!changed.changes) return { change: [], persona: false, status: this.requiredStatus(id) };
      const botId = this.target(id);
      if (typeof botId !== "string") throw new Error("import_job_missing");
      const change = this.memories.remove(id, botId);
      const persona = this.personas.undo(id, botId);
      return { change, persona, status: this.requiredStatus(id) };
    });
  }

  discard(id: string, state: CleanupTarget, reason: ImportStatus["reason"]) {
    this.db
      .prepare(`UPDATE import_jobs SET state=?,reason=?,cleanup_phase='discarding'
      WHERE id=? AND state='running'`)
      .run(state, reason, id);
  }

  recover() {
    this.db
      .prepare(`UPDATE import_jobs SET state='failed',reason='interrupted',
      cleanup_phase='discarding' WHERE state='running'`)
      .run();
  }

  nextCleanup(after = 0) {
    const row = this.db
      .prepare(`SELECT id,rowid AS cursor FROM import_jobs
      WHERE cleanup_phase IS NOT NULL AND rowid>? ORDER BY rowid LIMIT 1`)
      .get(after);
    return typeof row?.id === "string" && typeof row.cursor === "number"
      ? { id: row.id, cursor: row.cursor }
      : undefined;
  }

  cleanupPage(id: string) {
    return transaction(this.db, () => {
      const job = this.db
        .prepare(`SELECT state,reason,cleanup_phase FROM import_jobs
        WHERE id=? AND cleanup_phase IS NOT NULL`)
        .get(id);
      if (!job) throw new Error("import_cleanup_missing");
      const messages = this.deletePage("messages", id);
      const topics = messages === 0 ? this.deletePage("conversations", id) : 0;
      if (messages || topics) {
        this.db
          .prepare(`UPDATE import_jobs SET removed_messages=removed_messages+?,
          removed_topics=removed_topics+? WHERE id=?`)
          .run(messages, topics, id);
        return { status: this.requiredStatus(id), done: false };
      }
      const state =
        job.cleanup_phase === "undoing"
          ? "undone"
          : job.state === "cancelled"
            ? "cancelled"
            : "failed";
      const reason = ImportStatusSchema.shape.reason.parse(job.reason);
      return { status: this.finish(id, state, reason), done: true };
    });
  }

  private deletePage(table: "messages" | "conversations", id: string) {
    const remove = this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (
      SELECT rowid FROM ${table} WHERE import_id=? LIMIT ?)`);
    const start = performance.now();
    let removed = 0;
    do {
      const changes = Number(remove.run(id, DELETE_STEP).changes);
      removed += changes;
      if (changes !== DELETE_STEP) break;
    } while (removed < DELETE_RECORDS && performance.now() - start < DELETE_WORK_MS);
    return removed;
  }

  private requiredStatus(id: string) {
    const status = this.get(id);
    if (!status) throw new Error("import_job_missing");
    return status;
  }

  private finish(id: string, state: Terminal, reason: ImportStatus["reason"]) {
    this.db
      .prepare(`UPDATE import_jobs SET state=?,reason=?,cleanup_phase=NULL WHERE id=?`)
      .run(state, reason, id);
    const botId = this.target(id);
    if (typeof botId !== "string") throw new Error("import_job_missing");
    const status = this.requiredStatus(id);
    const { source, topics, messages, memories, persona, projectFile, keptProjectFile } = status;
    this.audit.append({
      botId,
      kind: "import.changed",
      summary: "Conversation import / 对话导入",
      detail: {
        actor: reason === "interrupted" ? "automatic" : "user",
        conversationImport: {
          importId: id,
          source,
          state,
          topics,
          messages,
          ...(memories === undefined ? {} : { memories }),
          ...(persona ? { persona } : {}),
          ...(projectFile ? { projectFile } : {}),
          ...(keptProjectFile ? { keptProjectFile } : {}),
        },
      },
    });
    return status;
  }
}
