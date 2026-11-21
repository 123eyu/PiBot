import type { DatabaseSync } from "node:sqlite";
import { type Run, RunSchema, WorkflowBudgetSchema } from "@pibot/protocol-base";
import { z } from "zod";

/**
 * The workflow identity a run keeps so that a restart does not turn it into plain chat.
 * Identity, never the skill body: recovery reads the skill again and refuses a changed version.
 * Bounds are wider than any contract produces, so persisting can never fail a send.
 */
export const RunWorkflowSchema = z.strictObject({
  skillId: z.string().min(1).max(200),
  version: z.number().int().positive().nullable(),
  params: z
    .array(z.strictObject({ name: z.string().max(200), value: z.string().max(16_000) }))
    .max(100),
  inputs: z
    .array(
      z.strictObject({
        name: z.string().max(200),
        kind: z.enum(["folder", "file", "text"]),
        value: z.string().max(16_000),
      }),
    )
    .max(100),
  /** This period's artifact folder, once known (a routine's, or the one the first start chose). */
  folder: z.string().min(1).max(4096).optional(),
  previous: z
    .strictObject({
      folder: z.string().min(1).max(4096),
      files: z.array(z.string().max(1024)).max(20),
    })
    .optional(),
  previousFromLedger: z.boolean().optional(),
  /** The contract budget the run started under; a recovered run never gets a larger one. */
  budget: WorkflowBudgetSchema.nullable(),
});
export type RunWorkflow = z.infer<typeof RunWorkflowSchema>;

export interface RunRecovery {
  runId: string;
  rootRunId: string | null;
  resumedFrom: string | null;
  workflow: RunWorkflow | null;
}

const columns =
  "run_id AS runId,root_run_id AS rootRunId,resumed_from AS resumedFrom,workflow_json AS workflow";

function parse(row: Record<string, unknown>): RunRecovery {
  const workflow =
    typeof row.workflow === "string" ? RunWorkflowSchema.safeParse(JSON.parse(row.workflow)) : null;
  return {
    runId: String(row.runId),
    rootRunId: typeof row.rootRunId === "string" ? row.rootRunId : null,
    resumedFrom: typeof row.resumedFrom === "string" ? row.resumedFrom : null,
    // A row from a newer or damaged build is "no workflow": recovery then refuses, never guesses.
    workflow: workflow?.success ? workflow.data : null,
  };
}

/**
 * Side table of `runs` (migration 0076). Written in the caller's transaction together with the
 * run row; read on restart, on resume and when a resumed run's budget root is needed.
 */
export class RunRecoveryRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(runId: string): RunRecovery | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM run_recovery WHERE run_id=?`).get(runId);
    return row ? parse(row) : undefined;
  }

  /** Budget / journal root of a resumed run; undefined for every other run. */
  root(runId: string): string | undefined {
    const row = this.db
      .prepare("SELECT root_run_id AS root FROM run_recovery WHERE run_id=?")
      .get(runId);
    return typeof row?.root === "string" ? row.root : undefined;
  }

  record(
    runId: string,
    value: { rootRunId?: string; resumedFrom?: string; workflow?: RunWorkflow },
  ) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO run_recovery(run_id,root_run_id,resumed_from,workflow_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?)`,
      )
      .run(
        runId,
        value.rootRunId ?? null,
        value.resumedFrom ?? null,
        value.workflow ? JSON.stringify(RunWorkflowSchema.parse(value.workflow)) : null,
        now,
        now,
      );
  }

  /** The folders the run engine chose on start, so a resume writes into the same period. */
  place(runId: string, place: { folder: string; previous?: { folder: string; files: string[] } }) {
    const current = this.get(runId)?.workflow;
    if (!current) return;
    const next = RunWorkflowSchema.parse({
      ...current,
      folder: place.folder,
      ...(place.previous ? { previous: place.previous } : {}),
    });
    this.db
      .prepare("UPDATE run_recovery SET workflow_json=?,updated_at=? WHERE run_id=?")
      .run(JSON.stringify(next), new Date().toISOString(), runId);
  }

  /**
   * Known costs of the last finished runs of one workflow (skill id + version), newest
   * first, one per budget root (a resumed chain counts once, at its root's total). Private chat
   * reads this Bot's runs outside groups; a group reads that group's runs. Only fully priced
   * roots count: a ledger with unpriced requests would understate the cost. Bounded twice: the
   * skill's own rows via `run_recovery_workflow_skill` (newest 200), then `limit` roots.
   */
  workflowCosts(
    skillId: string,
    version: number | null,
    scope: { botId: string; groupId?: string },
    limit = 5,
  ): number[] {
    const where = scope.groupId ? "r.group_id=?" : "r.bot_id=? AND r.group_id IS NULL";
    return this.db
      .prepare(
        `SELECT cost FROM (
          SELECT COALESCE(x.root_run_id,x.run_id) AS root,MAX(x.rowid) AS seq,
            json_extract(b.snapshot_json,'$.knownCostUsd') AS cost,
            json_extract(b.snapshot_json,'$.unknownCostRequests') AS unknown,
            json_extract(b.snapshot_json,'$.requests') AS requests
          FROM (SELECT rowid,run_id,root_run_id,workflow_json FROM run_recovery
            WHERE workflow_json IS NOT NULL AND json_extract(workflow_json,'$.skillId')=?
            ORDER BY rowid DESC LIMIT 200) x
          JOIN runs r ON r.id=x.run_id
          JOIN execution_budgets b ON b.root_run_id=COALESCE(x.root_run_id,x.run_id)
          WHERE json_extract(x.workflow_json,'$.version') IS ? AND r.status='done' AND ${where}
          GROUP BY root
        ) WHERE unknown=0 AND requests>0 AND cost>0 ORDER BY seq DESC LIMIT ?`,
      )
      .all(skillId, version, scope.groupId ?? scope.botId, Math.min(Math.max(limit, 1), 20))
      .map((row) => Number(row.cost))
      .filter((cost) => Number.isFinite(cost) && cost > 0);
  }

  /**
   * Private-chat workflow runs a restart left queued (`RunsRepo.recover` keeps exactly these),
   * oldest first. Bounded by the queue's own capacity.
   */
  queuedWorkflows(limit = 128): { run: Run; workflow: RunWorkflow | null }[] {
    return this.db
      .prepare(
        `SELECT r.id,r.bot_id AS botId,r.conversation_id AS conversationId,r.group_id AS groupId,
        r.kind,r.status,r.message_id AS messageId,r.user_message_id AS userMessageId,r.task_id AS taskId,
        r.cycle_id AS cycleId,r.automatic,r.parent_run_id AS parentRunId,r.after_run_id AS afterRunId,
        r.ancestry,r.trigger_key AS triggerKey,r.session_file AS sessionFile,r.stop_reason AS stopReason,
        r.error_code AS errorCode,r.created_at AS createdAt,r.started_at AS startedAt,
        r.finished_at AS finishedAt,x.workflow_json AS workflow
        FROM runs r JOIN run_recovery x ON x.run_id=r.id
        WHERE r.status='queued' AND ${KEPT_QUEUED} ORDER BY r.rowid LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 128))
      .map((row) => {
        const { workflow, ...run } = row;
        return {
          run: RunSchema.parse({
            ...run,
            automatic: run.automatic === 1,
            ancestry: JSON.parse(String(run.ancestry)),
          }),
          workflow: parse({ runId: row.id, workflow }).workflow,
        };
      });
  }
}

/**
 * Which queued runs survive a restart, over `runs r` joined to `run_recovery x`: a user's
 * private-chat workflow run, whose whole launch is rebuilt from the persisted identity. Every
 * other queued run carries in-memory input (attachment text, images, continuation authority)
 * that was never stored, so startup still ends it.
 */
export const KEPT_QUEUED =
  "r.kind='chat' AND r.group_id IS NULL AND r.automatic=0 AND r.task_id IS NULL AND x.workflow_json IS NOT NULL AND x.resumed_from IS NULL";
