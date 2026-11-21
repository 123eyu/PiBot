import type { DatabaseSync } from "node:sqlite";
import {
  type AuditDetail,
  AuditDetailSchema,
  type AuditKind,
  AuditKindSchema,
  type DeliveryEvidence,
  DeliveryEvidenceSchema,
  type ExecutionStall,
  ExecutionStallSchema,
  type GroupExecutionReceipt,
  GroupExecutionReceiptSchema,
  IdSchema,
  type ReceiptDelivery,
  ReceiptDeliverySchema,
} from "@pibot/protocol-base";
import { z } from "zod";
import { readCodeAnalysis } from "./tool-code-analysis.ts";

const PlanAtEndSchema = z.strictObject({
  open: z.number().int().nonnegative().safe(),
  total: z.number().int().nonnegative().safe(),
});

/** Audit kinds a receipt reads; anything else for the run is ignored. */
const RECEIPT_AUDIT_KINDS = [
  "file.read",
  "web.fetched",
  "search.sent",
  "connector.called",
  "phone.data_read",
  "messages.read",
  "exec.finished",
  "exec.background.started",
  "exec.background.stopped",
  "file.written",
  "file.sent",
  "image.finished",
  "collaboration.queued",
  "policy.denied",
  "autocheck.finished",
] as const satisfies readonly AuditKind[];
/** A runaway run must not make one receipt read an unbounded number of rows. */
const AUDIT_ROWS = 5_000;
const EVIDENCE_ROWS = 200;
const count = (row: Record<string, unknown> | undefined, key = "n") => Number(row?.[key] ?? 0);

export interface ReceiptAuditRow {
  kind: AuditKind;
  detail: AuditDetail;
}
/**
 * Read-only queries a run receipt is built from. Every query is keyed by run id (or the
 * run's budget root) on an indexed column and bounded; nothing here returns message text.
 */
export class RunReceiptRepo {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * One indexed query whose value changes whenever a record a receipt reads changes for this run:
   * status, audit rows (late background commands, draft sends), recorded file changes, restores,
   * approvals, the budget ledger, evidence, child tasks and the plan. A cached receipt is reused
   * while it is unchanged, so a finished run is rebuilt only when late records arrive.
   */
  fingerprint(runId: string, rootRunId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT r.status AS status,
        (SELECT COUNT(*) FROM audit_log WHERE run_id=r.id) AS audits,
        (SELECT COUNT(*)||':'||IFNULL(MAX(t.finished_at),'')||':'||IFNULL(SUM(t.code_analysis='{"engine":"tree-sitter","approximate":true}'),0)
          FROM tool_calls t JOIN messages m ON m.id=t.message_id WHERE m.run_id=r.id) AS toolFacts,
        (SELECT COUNT(*) FROM run_file_changes WHERE run_id=r.id) AS files,
        (SELECT COUNT(*)||':'||IFNULL(MAX(o.updated_at),'') FROM file_restore_operations o
          JOIN file_checkpoints c ON c.id=o.checkpoint_id WHERE c.run_id=r.id) AS restores,
        (SELECT COUNT(*)||':'||IFNULL(MAX(resolved_at),'') FROM approvals WHERE run_id=r.id) AS approvals,
        (SELECT updated_at FROM execution_budgets WHERE root_run_id=?) AS budget,
        (SELECT COUNT(*) FROM delivery_evidence WHERE root_run_id=?) AS evidence,
        (SELECT COUNT(*)||':'||IFNULL(MAX(updated_at),'') FROM task_instances WHERE root_run_id=?) AS tasks,
        (SELECT version FROM execution_todo WHERE bot_id=r.bot_id AND conversation_id=r.conversation_id) AS plan,
        (SELECT COUNT(*)||':'||IFNULL(MAX(updated_at),'') FROM tool_executions WHERE run_id=r.id
          AND state IN ('started','unknown')) AS uncertain,
        EXISTS(SELECT 1 FROM runs n WHERE n.conversation_id=r.conversation_id
          AND n.bot_id=r.bot_id AND n.rowid>r.rowid) AS newer
        FROM runs r WHERE r.id=?`,
      )
      .get(rootRunId, rootRunId, rootRunId, IdSchema.parse(runId));
    return row
      ? [
          row.status,
          row.audits,
          row.toolFacts,
          row.files,
          row.restores,
          row.approvals,
          row.budget,
          row.evidence,
          row.tasks,
          row.plan,
          row.uncertain,
          // A newer run in the topic withdraws the 「加预算继续」 offer.
          row.newer,
        ].join("|")
      : undefined;
  }

  audit(runId: string): { rows: ReceiptAuditRow[]; truncated: boolean } {
    const kinds = RECEIPT_AUDIT_KINDS.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT kind, detail FROM audit_log WHERE run_id=? AND kind IN (${kinds})
        ORDER BY at, id LIMIT ?`,
      )
      .all(IdSchema.parse(runId), ...RECEIPT_AUDIT_KINDS, AUDIT_ROWS + 1);
    const parsed: ReceiptAuditRow[] = [];
    for (const row of rows.slice(0, AUDIT_ROWS)) {
      const kind = AuditKindSchema.safeParse(row.kind);
      const detail = AuditDetailSchema.safeParse(JSON.parse(String(row.detail)));
      // Rows written by an older schema stay readable in the audit page; a receipt skips them.
      if (kind.success && detail.success) parsed.push({ kind: kind.data, detail: detail.data });
    }
    return { rows: parsed, truncated: rows.length > AUDIT_ROWS };
  }

  approvals(runId: string) {
    return this.db
      .prepare("SELECT status, COUNT(*) AS n FROM approvals WHERE run_id=? GROUP BY status")
      .all(IdSchema.parse(runId))
      .map((row) => ({ status: String(row.status), count: count(row) }));
  }

  /** Tool records of this run's replies, by tool and status; YOLO-allowed steps counted apart. */
  tools(runId: string) {
    return this.db
      .prepare(
        `SELECT t.tool AS tool, t.status AS status, t.code_analysis AS codeAnalysisJson, SUM(t.yolo_risk IS NOT NULL) AS yolo,
        COUNT(*) AS n FROM tool_calls t JOIN messages m ON m.id=t.message_id
        WHERE m.run_id=? GROUP BY t.tool, t.status, t.code_analysis`,
      )
      .all(IdSchema.parse(runId))
      .map((row) => {
        const codeAnalysis = readCodeAnalysis(row.codeAnalysisJson);
        return {
          tool: String(row.tool),
          ...(codeAnalysis ? { codeAnalysis } : {}),
          status: String(row.status),
          yolo: count(row, "yolo"),
          count: count(row),
        };
      });
  }

  /** Evidence recorded under the budget root, narrowed to this run unless it is the root. */
  evidence(rootRunId: string, runId: string): DeliveryEvidence[] {
    return this.db
      .prepare(
        `SELECT payload_json FROM delivery_evidence WHERE root_run_id=? AND (run_id=? OR root_run_id=?)
        ORDER BY created_at, id LIMIT ?`,
      )
      .all(IdSchema.parse(rootRunId), IdSchema.parse(runId), runId, EVIDENCE_ROWS)
      .flatMap((row) => {
        const parsed = DeliveryEvidenceSchema.safeParse(JSON.parse(String(row.payload_json)));
        return parsed.success ? [parsed.data] : [];
      });
  }

  childTasks(rootRunId: string, runId: string) {
    return this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM task_instances WHERE root_run_id=? AND parent_run_id=?
        GROUP BY status`,
      )
      .all(IdSchema.parse(rootRunId), IdSchema.parse(runId))
      .map((row) => ({ status: String(row.status), count: count(row) }));
  }

  /**
   * Distinct models this run's child tasks ran on, from each child reply's recorded model
   * (a `cheap` child shows the auxiliary model). Bounded by `task_root_status` and `limit`.
   */
  childModels(rootRunId: string, runId: string, limit: number) {
    return this.db
      .prepare(
        `SELECT DISTINCT json_extract(m.usage,'$.runModel.provider') AS provider,
        json_extract(m.usage,'$.runModel.id') AS id
        FROM task_instances t JOIN task_attempts a ON a.task_id=t.id
        JOIN runs r ON r.id=a.run_id JOIN messages m ON m.id=r.message_id
        WHERE t.root_run_id=? AND t.parent_run_id=? AND json_valid(m.usage)
          AND json_extract(m.usage,'$.runModel.id') IS NOT NULL
        LIMIT ?`,
      )
      .all(IdSchema.parse(rootRunId), IdSchema.parse(runId), limit)
      .flatMap((row) =>
        typeof row.provider === "string" && typeof row.id === "string"
          ? [{ provider: row.provider.slice(0, 100), id: row.id.slice(0, 200) }]
          : [],
      );
  }

  /**
   * Whether other runs spend from the same budget root: child tasks, or continuations (runs
   * whose trigger key starts with the brain's continuation prefix and point back at the root).
   */
  sharesBudget(rootRunId: string, runId: string, continuationPrefix: string): boolean {
    if (rootRunId !== runId) return true;
    return !!this.db
      .prepare(
        `SELECT 1 FROM task_instances WHERE root_run_id=? UNION ALL
        SELECT 1 FROM runs WHERE parent_run_id=? AND substr(trigger_key,1,?)=? LIMIT 1`,
      )
      .get(rootRunId, rootRunId, continuationPrefix.length, continuationPrefix);
  }

  connectorNames(ids: readonly string[]): Map<string, string> {
    const valid = [...new Set(ids)].filter((id) => IdSchema.safeParse(id).success).slice(0, 50);
    if (!valid.length) return new Map();
    return new Map(
      this.db
        .prepare(`SELECT id, name FROM connectors WHERE id IN (${valid.map(() => "?").join(",")})`)
        .all(...valid)
        .map((row) => [String(row.id), String(row.name)]),
    );
  }

  /**
   * Facts the run engine wrote on the run's reply (message usage JSON): the model it ran on, the
   * plan's open items when it ended and the workflow delivery check. Nothing
   * else is read from it; each part that does not validate is treated as absent.
   */
  /** The memory notes injected into this reply's prompts, with their current text. */
  usedMemories(messageId: string, limit: number) {
    const row = this.db.prepare("SELECT usage FROM messages WHERE id=?").get(messageId);
    let ids: string[] = [];
    try {
      const value = row?.usage ? JSON.parse(String(row.usage))?.memoryIds : undefined;
      if (Array.isArray(value))
        ids = value.filter(
          (id): id is string => typeof id === "string" && /^[\w-]{1,64}$/.test(id),
        );
    } catch {
      // A malformed usage blob only means the used notes are unknown for this receipt.
    }
    const shown = ids.slice(0, limit);
    const found = new Map<string, { scope: string; text: string }>();
    if (shown.length) {
      const rows = this.db
        .prepare(
          `SELECT id,scope,text FROM scoped_memories WHERE id IN (${shown.map(() => "?").join(",")})`,
        )
        .all(...shown);
      for (const r of rows)
        found.set(String(r.id), { scope: String(r.scope), text: String(r.text) });
    }
    return {
      total: ids.length,
      items: shown.map((id) => ({ id, ...(found.get(id) ?? { scope: null, text: null }) })),
    };
  }

  replyFacts(messageId: string): {
    model: { provider: string; id: string } | null;
    planAtEnd: { open: number; total: number } | null;
    delivery: ReceiptDelivery | null;
    groupExecution: GroupExecutionReceipt | null;
    executionStall: ExecutionStall | null;
    outputContinuations: number | null;
  } {
    const none = {
      model: null,
      planAtEnd: null,
      delivery: null,
      groupExecution: null,
      executionStall: null,
      outputContinuations: null,
    };
    const row = this.db.prepare("SELECT usage FROM messages WHERE id=?").get(messageId);
    if (!row?.usage) return none;
    let usage: {
      runModel?: unknown;
      planAtEnd?: unknown;
      outputContinuations?: unknown;
      delivery?: unknown;
      groupExecution?: unknown;
      executionPause?: { stall?: unknown };
    };
    try {
      usage = JSON.parse(String(row.usage)) ?? {};
    } catch {
      // A malformed usage blob only means these facts are unknown for this receipt.
      return none;
    }
    const model = usage.runModel as { provider?: unknown; id?: unknown } | undefined;
    const plan = PlanAtEndSchema.safeParse(usage.planAtEnd);
    const delivery = ReceiptDeliverySchema.safeParse(usage.delivery);
    const groupExecution = GroupExecutionReceiptSchema.safeParse(usage.groupExecution);
    const stall = ExecutionStallSchema.safeParse(usage.executionPause?.stall);
    return {
      model:
        typeof model?.provider === "string" && typeof model.id === "string"
          ? { provider: model.provider.slice(0, 100), id: model.id.slice(0, 200) }
          : null,
      planAtEnd: plan.success ? plan.data : null,
      delivery: delivery.success ? delivery.data : null,
      groupExecution: groupExecution.success ? groupExecution.data : null,
      executionStall: stall.success ? stall.data : null,
      // Our own runtime writes this count (never text); clamp it so a bad blob cannot inflate it.
      outputContinuations:
        typeof usage.outputContinuations === "number" &&
        Number.isInteger(usage.outputContinuations) &&
        usage.outputContinuations > 0 &&
        usage.outputContinuations <= 10
          ? usage.outputContinuations
          : null,
    };
  }

  /** The run updated its conversation's plan (a todo_update tool record in its replies). */
  updatedPlan(runId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM tool_calls t JOIN messages m ON m.id=t.message_id
        WHERE m.run_id=? AND t.tool='todo_update' LIMIT 1`,
      )
      .get(IdSchema.parse(runId));
  }

  isSubtask(runId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM task_attempts WHERE run_id=? LIMIT 1")
      .get(IdSchema.parse(runId));
  }
}
