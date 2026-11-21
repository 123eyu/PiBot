import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { transaction } from "../database/database.ts";
import { RunEventsRepo } from "./run-events.ts";

/** `started` before dispatch; a row a crash leaves in `started` has an unknown outcome. */
export type ToolJournalState = "started" | "done" | "failed" | "unknown";
export type JournalEffectClass = "idempotent" | "local_effect" | "external";

export interface ToolJournalEntry {
  id: string;
  botId: string;
  runId: string;
  rootRunId: string;
  attemptId: string;
  toolCallId: string;
  tool: string;
  effectClass: JournalEffectClass;
  argsDigest: string;
  ordinal: number;
  idempotencyKey: string;
  state: ToolJournalState;
  attempts: number;
  resultDigest: string | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const RowSchema = z.object({
  id: z.string(),
  botId: z.string(),
  runId: z.string(),
  rootRunId: z.string(),
  attemptId: z.string(),
  toolCallId: z.string(),
  tool: z.string(),
  effectClass: z.enum(["idempotent", "local_effect", "external"]),
  argsDigest: digest,
  ordinal: z.number().int().min(1),
  idempotencyKey: digest,
  state: z.enum(["started", "done", "failed", "unknown"]),
  attempts: z.number().int().min(1),
  resultDigest: digest.nullable(),
  resultSummary: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});
const columns = `id,bot_id AS botId,run_id AS runId,root_run_id AS rootRunId,attempt_id AS attemptId,
  tool_call_id AS toolCallId,tool,effect_class AS effectClass,args_digest AS argsDigest,ordinal,
  idempotency_key AS idempotencyKey,state,attempts,result_digest AS resultDigest,
  result_summary AS resultSummary,created_at AS createdAt,updated_at AS updatedAt,
  finished_at AS finishedAt`;
const parse = (row: Record<string, unknown>): ToolJournalEntry => RowSchema.parse(row);
/** Rows of one identity a root can hold before the journal refuses (bounds every lookup). */
export const TOOL_JOURNAL_IDENTITY_LIMIT = 200;
export const TOOL_JOURNAL_SUMMARY_LIMIT = 600;

/**
 * Execution journal (migration 0076). Single statements; the brain journal groups the
 * look-up and the `started` write in one transaction.
 */
export class ToolJournalRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): ToolJournalEntry | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM tool_executions WHERE id=?`).get(id);
    return row ? parse(row) : undefined;
  }

  /** Every row of one identity (same tool and arguments) in a root, oldest ordinal first. */
  identity(rootRunId: string, tool: string, argsDigest: string): ToolJournalEntry[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM tool_executions WHERE root_run_id=? AND tool=? AND args_digest=? ORDER BY ordinal LIMIT ?`,
      )
      .all(rootRunId, tool, argsDigest, TOOL_JOURNAL_IDENTITY_LIMIT + 1)
      .map(parse);
  }

  byKey(idempotencyKey: string): ToolJournalEntry | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM tool_executions WHERE idempotency_key=?`)
      .get(idempotencyKey);
    return row ? parse(row) : undefined;
  }

  create(
    input: Pick<
      ToolJournalEntry,
      | "botId"
      | "runId"
      | "rootRunId"
      | "attemptId"
      | "toolCallId"
      | "tool"
      | "effectClass"
      | "argsDigest"
      | "ordinal"
      | "idempotencyKey"
    >,
  ): ToolJournalEntry {
    const id = randomUUID(),
      at = new Date().toISOString();
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO tool_executions(id,bot_id,run_id,root_run_id,attempt_id,tool_call_id,tool,effect_class,
          args_digest,ordinal,idempotency_key,state,attempts,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'started',1,?,?)`,
        )
        .run(
          id,
          input.botId,
          input.runId,
          input.rootRunId,
          input.attemptId,
          input.toolCallId,
          input.tool,
          input.effectClass,
          input.argsDigest,
          input.ordinal,
          input.idempotencyKey,
          at,
          at,
        );
      const conversationId = this.conversation(input.runId);
      if (conversationId)
        new RunEventsRepo(this.db).append({
          runId: input.runId,
          conversationId,
          kind: "execution.started",
          at,
          payload: {
            executionId: id,
            toolCallId: input.toolCallId,
            tool: input.tool,
            effectClass: input.effectClass,
            argsDigest: input.argsDigest,
            idempotencyKey: input.idempotencyKey,
            state: "started",
          },
        });
    });
    return this.require(id);
  }

  /** An explicitly failed (or unverified idempotent) row runs again under the same key. */
  restart(id: string, call: { runId: string; toolCallId: string; attemptId: string }) {
    return transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE tool_executions SET state='started',attempts=attempts+1,run_id=?,tool_call_id=?,
          attempt_id=?,result_digest=NULL,result_summary=NULL,finished_at=NULL,updated_at=? WHERE id=?`,
        )
        .run(call.runId, call.toolCallId, call.attemptId, new Date().toISOString(), id);
      const entry = this.require(id);
      const conversationId = this.conversation(call.runId);
      if (conversationId)
        new RunEventsRepo(this.db).append({
          runId: call.runId,
          conversationId,
          kind: "execution.restarted",
          payload: { executionId: id, toolCallId: call.toolCallId, state: "started" },
        });
      return entry;
    });
  }

  /** A later attempt reused this row's outcome, so its ordinal counts for that attempt now. */
  claim(id: string, attemptId: string) {
    this.db
      .prepare("UPDATE tool_executions SET attempt_id=?,updated_at=? WHERE id=?")
      .run(attemptId, new Date().toISOString(), id);
  }

  finish(
    id: string,
    state: Exclude<ToolJournalState, "started">,
    result?: { digest: string | null; summary: string | null },
  ) {
    const at = new Date().toISOString();
    transaction(this.db, () => {
      const current = this.get(id);
      this.db
        .prepare(
          `UPDATE tool_executions SET state=?,result_digest=COALESCE(?,result_digest),
          result_summary=COALESCE(?,result_summary),finished_at=?,updated_at=? WHERE id=?`,
        )
        .run(
          state,
          result?.digest ?? null,
          result?.summary?.slice(0, TOOL_JOURNAL_SUMMARY_LIMIT) ?? null,
          at,
          at,
          id,
        );
      const conversationId = current ? this.conversation(current.runId) : undefined;
      if (current && conversationId)
        new RunEventsRepo(this.db).append({
          runId: current.runId,
          conversationId,
          kind: "execution.finished",
          at,
          payload: {
            executionId: id,
            state,
            resultDigest: result?.digest ?? null,
            resultSummary: result?.summary?.slice(0, TOOL_JOURNAL_SUMMARY_LIMIT) ?? null,
          },
        });
    });
  }

  /** Startup: in-flight rows of a previous process have an unknown outcome. Returns how many. */
  recover(): ToolJournalEntry[] {
    const rows = this.db
      .prepare(`SELECT ${columns} FROM tool_executions WHERE state='started'`)
      .all()
      .map(parse);
    if (rows.length)
      transaction(this.db, () => {
        const at = new Date().toISOString();
        this.db
          .prepare(
            "UPDATE tool_executions SET state='unknown',finished_at=?,updated_at=? WHERE state='started'",
          )
          .run(at, at);
        const events = new RunEventsRepo(this.db);
        for (const row of rows) {
          const conversationId = this.conversation(row.runId);
          if (conversationId)
            events.append({
              runId: row.runId,
              conversationId,
              kind: "execution.finished",
              at,
              payload: { executionId: row.id, state: "unknown" },
            });
        }
      });
    return rows;
  }

  /** A run's journal, oldest first, keyset-paged by creation time and id. */
  forRun(runId: string, page: { after?: string; limit?: number } = {}): ToolJournalEntry[] {
    const limit = Math.min(Math.max(page.limit ?? 100, 1), 200);
    const after = page.after ? this.get(page.after) : undefined;
    return (
      after
        ? this.db
            .prepare(
              `SELECT ${columns} FROM tool_executions WHERE run_id=? AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT ?`,
            )
            .all(runId, after.createdAt, after.id, limit)
        : this.db
            .prepare(
              `SELECT ${columns} FROM tool_executions WHERE run_id=? ORDER BY created_at,id LIMIT ?`,
            )
            .all(runId, limit)
    ).map(parse);
  }

  /** Receipt: calls of a run whose outcome is unknown (or still in flight), oldest first. */
  uncertain(runId: string, limit = 50): ToolJournalEntry[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM tool_executions WHERE run_id=? AND state IN ('started','unknown') ORDER BY created_at,id LIMIT ?`,
      )
      .all(runId, Math.min(Math.max(limit, 1), 200))
      .map(parse);
  }

  /** How many of a run's calls have an unknown outcome (the receipt lists the first few). */
  uncertainCount(runId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tool_executions WHERE run_id=? AND state IN ('started','unknown')",
      )
      .get(runId);
    return Number(row?.n ?? 0);
  }

  private require(id: string): ToolJournalEntry {
    const entry = this.get(id);
    if (!entry) throw new Error("Tool journal entry missing");
    return entry;
  }

  private conversation(runId: string): string | undefined {
    const row = this.db.prepare("SELECT conversation_id FROM runs WHERE id=?").get(runId);
    return row ? String(row.conversation_id) : undefined;
  }
}
