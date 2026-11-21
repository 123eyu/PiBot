import type { GroupWorkflowRunRecord, GroupWorkflowStepRecord } from "@pibot/storage";
import { transaction } from "@pibot/storage";
import { progressOf } from "./group-workflow-progress.ts";
import { type WorkflowEngine, workflowOf } from "./group-workflow-snapshot.ts";

export interface ResumedStep {
  workflowRunId: string;
  stepId: string;
  title: string;
}

/**
 * Maintainers 2026-11-20: the group's pause stops the running steps without failing them. A stopped
 * step goes back to `ready` at the same attempt, so it neither needs a decision card nor spends a
 * fix round; the scheduler leaves ready steps alone while the group is paused (see dispatch) and
 * runs them again on continue.
 */
export class GroupWorkflowPause {
  constructor(private readonly engine: WorkflowEngine) {}

  /** Called by the reconciler when a running step's run ended because the group was paused. */
  park(record: GroupWorkflowRunRecord, step: GroupWorkflowStepRecord) {
    const { service, repo, progress } = this.engine;
    if (this.engine.closed || service.deps.local.shutdown.signal.aborted) return;
    const changed = transaction(service.deps.db, () => {
      const latestRun = repo.get(record.id);
      const current = repo.steps(record.id).find((item) => item.stepId === step.stepId);
      if (
        !latestRun ||
        !["running", "waiting"].includes(latestRun.status) ||
        current?.status !== "running" ||
        current.executionRunId !== step.executionRunId
      )
        return false;
      // The stopped run stays the step's execution, so the rerun gets its hand-back as context
      // and a fresh trigger key (dispatch); the task is replaced like a retry's.
      repo.updateStep(record.id, step.stepId, { status: "ready", taskId: null });
      const ledger = progressOf(latestRun);
      progress.save(latestRun, { ...ledger, paused: { ...ledger.paused, [step.stepId]: true } });
      if (current.taskId) service.cycles.claimWake(current.taskId);
      this.engine.audit(
        latestRun,
        "group.workflow.disposition",
        "Group plan step paused with the group / 群暂停，计划步骤已停下",
        { actor: "user", stepId: step.stepId, reasonCode: "group_paused" },
      );
      return true;
    });
    if (!changed) return;
    if (step.taskId) {
      service.handoffs.settled(step.taskId);
      const task = service.tasks.get(step.taskId);
      if (task) service.taskChanged(task);
    }
    service.changed(record.groupId, "updated");
  }

  /**
   * Video rehearsal 2026-11-20: a member's run stopped as repeated_operation (the same rejected
   * click three times) and the group sat at 需要你 although a fresh run usually gets past it. The
   * program runs such a step once more at the same attempt, with the stopped run as hand-back
   * context; returns false when it already did, so the caller blocks the step for the user.
   */
  retryAfterLoop(record: GroupWorkflowRunRecord, step: GroupWorkflowStepRecord): boolean {
    const { service, repo, progress } = this.engine;
    if (this.engine.closed || service.deps.local.shutdown.signal.aborted) return false;
    if (service.pausedFor(record.groupId)) return false;
    const changed = transaction(service.deps.db, () => {
      const latestRun = repo.get(record.id);
      const current = repo.steps(record.id).find((item) => item.stepId === step.stepId);
      if (
        !latestRun ||
        !["running", "waiting"].includes(latestRun.status) ||
        current?.status !== "running" ||
        current.executionRunId !== step.executionRunId
      )
        return false;
      const ledger = progressOf(latestRun);
      if (ledger.loopRetried?.[step.stepId]) return false;
      repo.updateStep(record.id, step.stepId, { status: "ready", taskId: null });
      progress.save(latestRun, {
        ...ledger,
        loopRetried: { ...ledger.loopRetried, [step.stepId]: true },
      });
      if (current.taskId) service.cycles.claimWake(current.taskId);
      this.engine.audit(
        latestRun,
        "group.workflow.disposition",
        "Group plan step retried once after a repeated-action loop / 步骤陷入重复操作，程序自动重试一次",
        {
          actor: "automatic",
          stepId: step.stepId,
          workflowAction: "retry",
          reasonCode: "repeated_operation",
        },
      );
      return true;
    });
    if (!changed) return false;
    if (step.taskId) {
      service.handoffs.settled(step.taskId);
      const task = service.tasks.get(step.taskId);
      if (task) service.taskChanged(task);
    }
    service.deps.logger.info(
      JSON.stringify({
        module: "group-workflow",
        event: "loop_retry",
        workflowRunId: record.id,
        stepId: step.stepId,
      }),
    );
    this.engine.schedule(record.id);
    service.changed(record.groupId, "updated");
    return true;
  }

  /**
   * The group continued: every step its pause stopped runs again (the retry path: `ready` and a
   * schedule), and plans whose ready steps waited for the pause are scheduled too.
   */
  resume(groupId: string): ResumedStep[] {
    const { service, repo, progress } = this.engine;
    if (this.engine.closed) return [];
    const resumed: ResumedStep[] = [];
    const scheduled: string[] = [];
    for (const record of repo.activeForGroup(groupId)) {
      const steps = transaction(service.deps.db, () => {
        const latest = repo.get(record.id);
        if (!latest || !["running", "waiting"].includes(latest.status)) return [];
        const ledger = progressOf(latest);
        const ids = Object.keys(ledger.paused ?? {});
        if (!ids.length) return [];
        progress.save(latest, { ...ledger, paused: undefined });
        // Messages sent while paused may have started a new cycle; the plan follows it, as a retry.
        const cycleId = service.cycles.get(groupId).cycleId ?? service.cycles.reset(groupId);
        if (latest.cycleId !== cycleId) repo.rebindCycle(latest.id, cycleId);
        const titles = new Map(workflowOf(latest).contract.steps?.map((s) => [s.id, s.title]));
        const ready = new Set(
          repo
            .steps(latest.id)
            .filter((state) => state.status === "ready")
            .map((s) => s.stepId),
        );
        const picked = ids.filter((id) => ready.has(id));
        for (const stepId of picked)
          this.engine.audit(
            latest,
            "group.workflow.disposition",
            "Group plan step continued with the group / 群继续，计划步骤接着做",
            { actor: "user", stepId, workflowAction: "retry", reasonCode: "group_resumed" },
          );
        return picked.map((stepId) => ({
          workflowRunId: latest.id,
          stepId,
          title: titles.get(stepId) ?? stepId,
        }));
      });
      resumed.push(...steps);
      scheduled.push(record.id);
    }
    for (const id of scheduled) this.engine.schedule(id);
    if (scheduled.length) service.changed(groupId, "updated");
    return resumed;
  }

  /** Steps the pause is holding, for the progress facts and status lines. */
  static held(record: GroupWorkflowRunRecord) {
    return new Set(Object.keys(progressOf(record).paused ?? {}));
  }
}
