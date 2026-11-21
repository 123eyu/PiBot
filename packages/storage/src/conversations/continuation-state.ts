import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Page } from "@pibot/protocol-base";
import { z } from "zod";
import { readPage } from "../database/paging.ts";

const count = z.number().int().nonnegative();

/**
 * Phase 3: the round budget of one root run. Amounts and streaks only — the same values
 * the in-memory ledger kept, so a restart resumes the chain with the same remaining rounds.
 */
export const ContinuationLedgerSchema = z.strictObject({
  rootRunId: z.uuid(),
  used: count,
  idleTodo: count,
  idleParent: count,
  idleSummary: count,
  updatedAt: z.iso.datetime(),
});
export type ContinuationLedger = z.infer<typeof ContinuationLedgerSchema>;
const ledgerColumns = `root_run_id AS rootRunId,used,idle_todo AS idleTodo,idle_parent AS idleParent,
 idle_summary AS idleSummary,updated_at AS updatedAt`;

export class ContinuationLedgersRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(rootRunId: string): ContinuationLedger | undefined {
    const row = this.db
      .prepare(`SELECT ${ledgerColumns} FROM continuation_ledgers WHERE root_run_id=?`)
      .get(z.uuid().parse(rootRunId));
    return row ? ContinuationLedgerSchema.parse(row) : undefined;
  }
  /** The capacity rule counts live roots; a full table must still refuse a new root. */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM continuation_ledgers").get();
    return Number(row?.total ?? 0);
  }
  save(value: Omit<ContinuationLedger, "updatedAt">): ContinuationLedger {
    const ledger = ContinuationLedgerSchema.parse({
      ...value,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare(`INSERT INTO continuation_ledgers(root_run_id,used,idle_todo,idle_parent,idle_summary,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(root_run_id) DO UPDATE SET used=excluded.used,
      idle_todo=excluded.idle_todo,idle_parent=excluded.idle_parent,
      idle_summary=excluded.idle_summary,updated_at=excluded.updated_at`)
      .run(
        ledger.rootRunId,
        ledger.used,
        ledger.idleTodo,
        ledger.idleParent,
        ledger.idleSummary,
        ledger.updatedAt,
      );
    return ledger;
  }
  release(rootRunId: string) {
    this.db
      .prepare("DELETE FROM continuation_ledgers WHERE root_run_id=?")
      .run(z.uuid().parse(rootRunId));
  }
  /**
   * The startup sweep's walk over ledgers. Keyed by root id rather than a row cursor, so releasing
   * the root just read cannot end the walk early.
   */
  roots(after: string | null, limit: number): string[] {
    return rootPage(this.db, "continuation_ledgers", after, limit);
  }
}

function rootPage(db: DatabaseSync, table: string, after: string | null, limit: number) {
  const rows = db
    .prepare(
      `SELECT DISTINCT root_run_id AS root FROM ${table} WHERE root_run_id > ? ORDER BY root_run_id LIMIT ?`,
    )
    .all(after === null ? "" : z.uuid().parse(after), count.positive().max(500).parse(limit));
  return rows.map((row) => z.uuid().parse(row.root));
}

/**
 * One restorable automatic continuation. Only references are kept: the frozen authority is named
 * by `authorityRef` and re-read from its own row, so a restored intent can never mint wider
 * permission than the record it points at. `planFingerprint` holds item ids and statuses, which
 * the in-memory intent already used to decide progress; no prompt, result or message text lives
 * in this table.
 */
/**
 * 'unknown' is reserved for rows written before migration 0063: a restore must refuse them rather
 * than read a missing pause as "not paused". New writes always name the real state.
 */
export const ContinuationPauseSchema = z.enum(["clear", "paused", "unknown"]);
export type ContinuationPauseState = z.infer<typeof ContinuationPauseSchema>;

export const ContinuationIntentSchema = z.strictObject({
  id: z.uuid(),
  rootRunId: z.uuid(),
  kind: z.enum(["parent", "summary", "worktree"]),
  subjectId: z.string().max(200),
  botId: z.uuid(),
  conversationId: z.uuid(),
  runId: z.uuid().nullable(),
  authorityRef: z.uuid().nullable(),
  planVersion: z.number().int().nonnegative().nullable(),
  planFingerprint: z.string().max(20_000).nullable(),
  progress: count.nullable(),
  triggerId: z.string().max(1_024).nullable(),
  groupId: z.uuid().nullable(),
  taskId: z.uuid().nullable(),
  pauseState: ContinuationPauseSchema,
  /** Reason code only (`waiting_tasks`, `needs_user`, …); never the pause summary. */
  pauseReason: z.string().max(100).nullable(),
  taskVersion: count.nullable(),
  /** The run this exact summary batch was queued as; null until dispatch succeeds. */
  dispatchedRunId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type ContinuationIntent = z.infer<typeof ContinuationIntentSchema>;
export type ContinuationIntentKind = ContinuationIntent["kind"];
const intentColumns = `id,root_run_id AS rootRunId,kind,subject_id AS subjectId,bot_id AS botId,
 conversation_id AS conversationId,run_id AS runId,authority_ref AS authorityRef,
 plan_version AS planVersion,plan_fingerprint AS planFingerprint,progress,trigger_id AS triggerId,
 group_id AS groupId,task_id AS taskId,pause_state AS pauseState,pause_reason AS pauseReason,
 task_version AS taskVersion,dispatched_run_id AS dispatchedRunId,created_at AS createdAt`;

/** One settled child attempt: the identity a dispatch may consume, never a whole task list. */
export interface ContinuationBatchEntry {
  subjectId: string;
  version: number;
}

/** SQLite bounds the bound parameters per statement; a batch chunk stays well below that. */
const BATCH_CHUNK = 200;

function batchChunks(batch: readonly ContinuationBatchEntry[]): ContinuationBatchEntry[][] {
  const values = batch.map((entry) => ({
    subjectId: z.string().max(200).parse(entry.subjectId),
    version: count.parse(entry.version),
  }));
  const chunks: ContinuationBatchEntry[][] = [];
  for (let index = 0; index < values.length; index += BATCH_CHUNK)
    chunks.push(values.slice(index, index + BATCH_CHUNK));
  return chunks;
}

export class ContinuationIntentsRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(
    rootRunId: string,
    kind: ContinuationIntentKind,
    subjectId = "",
  ): ContinuationIntent | undefined {
    const row = this.db
      .prepare(
        `SELECT ${intentColumns} FROM continuation_intents WHERE root_run_id=? AND kind=? AND subject_id=?`,
      )
      .get(z.uuid().parse(rootRunId), kind, subjectId);
    return row ? ContinuationIntentSchema.parse(row) : undefined;
  }
  /** Root-scoped pages for callers that walk one tree; never a whole-table read. */
  pageRoot(rootRunId: string, page: Page = {}): ContinuationIntent[] {
    return readPage(this.db, "continuation_intents", intentColumns, "created_at", page, [
      ["root_run_id", z.uuid().parse(rootRunId)],
    ]).map((row) => ContinuationIntentSchema.parse(row));
  }
  /** The restart prompt lists one topic at a time; callers never scan the whole table. */
  page(conversationId: string, page: Page = {}): ContinuationIntent[] {
    return readPage(this.db, "continuation_intents", intentColumns, "created_at", page, [
      ["conversation_id", z.uuid().parse(conversationId)],
    ]).map((row) => ContinuationIntentSchema.parse(row));
  }
  save(
    value: Omit<ContinuationIntent, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): ContinuationIntent {
    const intent = ContinuationIntentSchema.parse({
      ...value,
      id: value.id ?? randomUUID(),
      createdAt: value.createdAt ?? new Date().toISOString(),
    });
    // The identity index is the upsert target: a refreshed spawn or a repeated failure keeps one
    // row per continuation, and created_at stays at the first sighting. RETURNING keeps the
    // caller's idea of id/createdAt identical to the stored row, so paging with that cursor works.
    const row = this.db
      .prepare(`INSERT INTO continuation_intents(id,root_run_id,kind,subject_id,bot_id,conversation_id,
      run_id,authority_ref,plan_version,plan_fingerprint,progress,trigger_id,group_id,task_id,
      pause_state,pause_reason,task_version,dispatched_run_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(root_run_id,kind,subject_id) DO UPDATE SET bot_id=excluded.bot_id,
      conversation_id=excluded.conversation_id,run_id=excluded.run_id,
      authority_ref=excluded.authority_ref,plan_version=excluded.plan_version,
      plan_fingerprint=excluded.plan_fingerprint,progress=excluded.progress,
      trigger_id=excluded.trigger_id,group_id=excluded.group_id,task_id=excluded.task_id,
      pause_state=excluded.pause_state,pause_reason=excluded.pause_reason,
      task_version=excluded.task_version,dispatched_run_id=excluded.dispatched_run_id
      RETURNING ${intentColumns}`)
      .get(
        intent.id,
        intent.rootRunId,
        intent.kind,
        intent.subjectId,
        intent.botId,
        intent.conversationId,
        intent.runId,
        intent.authorityRef,
        intent.planVersion,
        intent.planFingerprint,
        intent.progress,
        intent.triggerId,
        intent.groupId,
        intent.taskId,
        intent.pauseState,
        intent.pauseReason,
        intent.taskVersion,
        intent.dispatchedRunId,
        intent.createdAt,
      );
    return ContinuationIntentSchema.parse(row);
  }
  /**
   * Mirrors the parent execution context: the stop code of a chain and the run/plan actually
   * driving it. Only an existing parent row is updated, so a pause never invents an intent; an
   * omitted field keeps its stored value (a spawn-time plan version must not become null).
   */
  pause(
    rootRunId: string,
    state: Exclude<ContinuationPauseState, "unknown">,
    reason: string | null,
    context: { runId?: string; planVersion?: number } = {},
  ) {
    this.db
      .prepare(
        `UPDATE continuation_intents SET pause_state=?,pause_reason=?,run_id=COALESCE(?,run_id),
         plan_version=COALESCE(?,plan_version)
         WHERE root_run_id=? AND kind='parent'`,
      )
      .run(
        state,
        reason,
        context.runId ? z.uuid().parse(context.runId) : null,
        context.planVersion === undefined ? null : count.parse(context.planVersion),
        z.uuid().parse(rootRunId),
      );
  }
  /** Last admitted plan/progress baseline of a parent resume, used to rebuild no-progress streaks. */
  baseline(rootRunId: string, planFingerprint: string | null, progress: number | null) {
    this.db
      .prepare(
        `UPDATE continuation_intents SET plan_fingerprint=?,progress=?
         WHERE root_run_id=? AND kind='parent'`,
      )
      .run(planFingerprint, progress, z.uuid().parse(rootRunId));
  }
  /**
   * Marks which exact summary batch was queued (and as which run); null clears a reclaimed one.
   * Scoped by task version: a newer settlement of the same task keeps its own unconsumed row.
   */
  dispatched(rootRunId: string, batch: readonly ContinuationBatchEntry[], runId: string | null) {
    for (const chunk of batchChunks(batch))
      this.db
        .prepare(
          `UPDATE continuation_intents SET dispatched_run_id=? WHERE root_run_id=? AND kind='summary'
           AND (${chunk.map(() => "(subject_id=? AND task_version=?)").join(" OR ")})`,
        )
        .run(
          runId ? z.uuid().parse(runId) : null,
          z.uuid().parse(rootRunId),
          ...chunk.flatMap((entry) => [entry.subjectId, entry.version]),
        );
  }
  /** Deletes exactly the rows a run consumed; never a newer version of the same task. */
  consume(rootRunId: string, batch: readonly ContinuationBatchEntry[]) {
    for (const chunk of batchChunks(batch))
      this.db
        .prepare(
          `DELETE FROM continuation_intents WHERE root_run_id=? AND kind='summary'
           AND (${chunk.map(() => "(subject_id=? AND task_version=?)").join(" OR ")})`,
        )
        .run(
          z.uuid().parse(rootRunId),
          ...chunk.flatMap((entry) => [entry.subjectId, entry.version]),
        );
  }
  /**
   * Settled results no run has consumed yet: the evidence a restart prompt may still summarize.
   * Root-scoped and bounded, like every other read of this table.
   */
  undispatched(rootRunId: string, limit = 1): ContinuationIntent[] {
    return (
      this.db
        .prepare(
          `SELECT ${intentColumns} FROM continuation_intents
           WHERE root_run_id=? AND kind='summary' AND dispatched_run_id IS NULL LIMIT ?`,
        )
        .all(z.uuid().parse(rootRunId), count.parse(limit)) as Record<string, unknown>[]
    ).map((row) => ContinuationIntentSchema.parse(row));
  }
  delete(rootRunId: string, kind: ContinuationIntentKind, subjectId = ""): boolean {
    return (
      this.db
        .prepare("DELETE FROM continuation_intents WHERE root_run_id=? AND kind=? AND subject_id=?")
        .run(z.uuid().parse(rootRunId), kind, subjectId).changes > 0
    );
  }
  /** Drops one kind of intent without touching the other rows of the same root. */
  deleteKind(rootRunId: string, kind: ContinuationIntentKind) {
    this.db
      .prepare("DELETE FROM continuation_intents WHERE root_run_id=? AND kind=?")
      .run(z.uuid().parse(rootRunId), kind);
  }
  /** Releasing a root removes every intent of its tree; a ledger alone never means "keep going". */
  release(rootRunId: string) {
    this.db
      .prepare("DELETE FROM continuation_intents WHERE root_run_id=?")
      .run(z.uuid().parse(rootRunId));
  }
  /** The startup scan's walk over every root with a stored intent (P3-T3); see `rootPage`. */
  roots(after: string | null, limit: number): string[] {
    return rootPage(this.db, "continuation_intents", after, limit);
  }
  has(rootRunId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM continuation_intents WHERE root_run_id=? LIMIT 1")
      .get(z.uuid().parse(rootRunId));
  }
}
