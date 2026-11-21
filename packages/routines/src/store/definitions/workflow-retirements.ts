import type { DatabaseSync } from "node:sqlite";
import { IdSchema, type WorkflowBudget, WorkflowBudgetSchema } from "@pibot/protocol";

export interface WorkflowRetirement {
  routineId: string;
  skillId: string;
  kind: "workflow" | "saved_plan";
}

/**
 * Migration 0102: routines once bound to a workflow skill, settled one by one, and the
 * contract budget a retired binding left on its routine (the routine's own column, not part of
 * the public `Routine`: the editor never shows or changes it).
 */
export class RoutineWorkflowRetirementsRepo {
  constructor(private readonly db: DatabaseSync) {}
  pending(limit = 200): WorkflowRetirement[] {
    return this.db
      .prepare(
        "SELECT routine_id AS routineId,skill_id AS skillId,kind FROM routine_workflow_retirements WHERE state='pending' ORDER BY routine_id LIMIT ?",
      )
      .all(limit)
      .map((row) => ({
        routineId: IdSchema.parse(row.routineId),
        skillId: String(row.skillId),
        kind: row.kind === "saved_plan" ? "saved_plan" : "workflow",
      }));
  }
  settle(
    routineId: string,
    state: "planned" | "kept" | "skipped" | "failed",
    reason: string | null = null,
  ) {
    this.db
      .prepare(
        "UPDATE routine_workflow_retirements SET state=?,reason=?,settled_at=? WHERE routine_id=? AND state='pending'",
      )
      .run(state, reason, new Date().toISOString(), routineId);
  }
  setBudget(routineId: string, budget: WorkflowBudget | null) {
    this.db
      .prepare("UPDATE routines SET budget=? WHERE id=?")
      .run(budget ? JSON.stringify(WorkflowBudgetSchema.parse(budget)) : null, routineId);
  }
  /** Lowers a run's execution limits only; an unreadable value is treated as no budget. */
  budget(routineId: string): WorkflowBudget | undefined {
    const row = this.db.prepare("SELECT budget FROM routines WHERE id=?").get(routineId);
    if (row?.budget == null) return undefined;
    try {
      const parsed = WorkflowBudgetSchema.safeParse(JSON.parse(String(row.budget)));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}
