import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_EXECUTION_LIMITS,
  type ExecutionLimits,
  type ExecutionMode,
  GroupExecutionSettingsSchema,
  GroupExecutionUsageSchema,
  IdSchema,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { ExecutionConflictError } from "../execution/execution.ts";
import { BudgetRepo } from "../execution/execution-budget.ts";

/** Group caps also bound cycle totals; existing root snapshots stay frozen. */
export class GroupExecutionLimitsRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(groupId: string) {
    const row = this.db
      .prepare(
        "SELECT mode,limits_json,version,updated_at FROM group_execution_limits WHERE group_id=?",
      )
      .get(IdSchema.parse(groupId));
    return GroupExecutionSettingsSchema.parse({
      groupId,
      mode: row?.mode ?? "execute",
      limits: row
        ? JSON.parse(String(row.limits_json))
        : { ...DEFAULT_EXECUTION_LIMITS, modelRequests: 160, costUsd: null, activeSeconds: 3_600 },
      version: row ? Number(row.version) : 0,
      updatedAt: row ? String(row.updated_at) : null,
    });
  }
  set(
    groupId: string,
    expectedVersion: number,
    change: { limits?: ExecutionLimits; mode?: ExecutionMode },
  ) {
    return transaction(this.db, () => {
      const before = this.get(groupId);
      if (before.version !== expectedVersion) throw new ExecutionConflictError();
      const next = GroupExecutionSettingsSchema.parse({
        ...before,
        limits: change.limits ?? before.limits,
        mode: change.mode ?? before.mode,
        version: before.version + 1,
        updatedAt: new Date().toISOString(),
      });
      this.db
        .prepare(`INSERT INTO group_execution_limits(group_id,mode,limits_json,version,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(group_id) DO UPDATE SET mode=excluded.mode,limits_json=excluded.limits_json,version=excluded.version,updated_at=excluded.updated_at`)
        .run(groupId, next.mode, JSON.stringify(next.limits), next.version, next.updatedAt);
      return next;
    });
  }
  usage(groupId: string, conversationId: string, cycleId: string | null, wholeCycle = false) {
    // A budget root appears once by primary key. AF6 attempts and result continuations are already
    // charged to that root, so joining their run rows would double count observations.
    const row = this.db
      .prepare(`SELECT COUNT(*) AS rootCount,
      COALESCE(SUM(json_extract(b.snapshot_json,'$.activeMillis')),0) AS activeMillis,
      COALESCE(SUM(json_extract(b.snapshot_json,'$.tools')),0) AS tools,
      COALESCE(SUM(json_extract(b.snapshot_json,'$.requests')),0) AS requests,
      COALESCE(SUM(json_extract(b.snapshot_json,'$.childTasks')),0) AS childTasks,
      COALESCE(SUM(json_extract(b.snapshot_json,'$.activeChildren')),0) AS activeChildren,
      COALESCE(MAX(json_extract(b.snapshot_json,'$.maxDepth')),0) AS maxDepth,
      COALESCE(SUM(json_extract(b.snapshot_json,'$.observedTokens')),0) AS observedTokens,
      COALESCE(SUM(json_extract(b.snapshot_json,'$.knownCostUsd')),0) AS knownCostUsd,
      COALESCE(SUM(json_extract(b.snapshot_json,'$.unknownUsageRequests')),0) AS unknownUsageRequests,
      COALESCE(SUM(json_extract(b.snapshot_json,'$.unknownCostRequests')),0) AS unknownCostRequests,
      COALESCE(SUM(json_extract(b.snapshot_json,'$.exhaustedReason') IS NOT NULL),0) AS exhaustedRoots,
      COALESCE(SUM(json_extract(b.snapshot_json,'$.exhaustedReason')='repeated_operation'),0) AS repeatedRoots
      FROM execution_budgets b JOIN runs r ON r.id=b.root_run_id
      JOIN conversations c ON c.id=r.conversation_id
      WHERE r.group_id=? AND r.cycle_id=? AND (? OR (c.group_id=r.group_id AND (c.id=? OR (c.kind='thread' AND c.thread_of=?))))`)
      .get(groupId, cycleId, wholeCycle ? 1 : 0, conversationId, conversationId);
    const { rootCount, ...totals } = row as Record<string, number>;
    return GroupExecutionUsageSchema.parse({ groupId, conversationId, cycleId, rootCount, totals });
  }
  /** Attempts count reserved repair rounds; replans are persisted by the existing scheduler. */
  retryCount(groupId: string, cycleId: string) {
    const row = this.db
      .prepare(`SELECT
      (SELECT COALESCE(SUM(s.attempt),0) FROM group_workflow_steps s
       JOIN group_workflow_runs w ON w.id=s.workflow_run_id WHERE w.group_id=? AND w.cycle_id=?) +
      (SELECT COALESCE(SUM(replans),0) FROM (
         SELECT MAX(COALESCE(json_extract(workflow_json,'$.progress.replans'),0)) AS replans
         FROM group_workflow_runs WHERE group_id=? AND cycle_id=?
         GROUP BY COALESCE(budget_root_run_id,id))) AS retries`)
      .get(groupId, cycleId, groupId, cycleId);
    return Number(row?.retries ?? 0);
  }
  /** Persist every root's stop, including roots with no live session after a restart. */
  exhaustCycle(groupId: string, cycleId: string, reason: string) {
    const budgets = new BudgetRepo(this.db);
    transaction(this.db, () => {
      let after = "";
      for (;;) {
        const page = this.db
          .prepare(`SELECT b.root_run_id AS id FROM execution_budgets b
          JOIN runs r ON r.id=b.root_run_id
          WHERE r.group_id=? AND r.cycle_id=? AND b.root_run_id>? ORDER BY b.root_run_id LIMIT 100`)
          .all(groupId, cycleId, after);
        for (const row of page)
          budgets.change(String(row.id), (value) => {
            value.exhaustedReason ??= reason;
          });
        if (page.length < 100) break;
        after = String(page.at(-1)?.id);
      }
    });
  }
}
