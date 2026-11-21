import type { Run } from "@pibot/protocol-base";
import type {
  GroupWorkflowRunRecord,
  GroupWorkflowStepRecord,
  GroupWorkflowsRepo,
} from "@pibot/storage";
import type { GroupService } from "./group-service.ts";
import { stepFailureReason } from "./group-step-failure.ts";
import { pendingStepQuestion } from "./group-step-question.ts";
import { stepExecution } from "./group-workflow-execution.ts";

/** Queue notifications are a fast path; paged reconciliation also covers queued cancellation
 * and handoff checks which finish after a chat cycle has been replaced. Owned by the scheduler. */
export class GroupWorkflowReconciler {
  private timer?: ReturnType<typeof setInterval>;
  private cursor: [string, string] = ["", ""];
  private activeCursor?: string;
  constructor(
    private readonly service: GroupService,
    private readonly repo: GroupWorkflowsRepo,
    private readonly block: (
      record: GroupWorkflowRunRecord,
      step: GroupWorkflowStepRecord,
      reason: string,
    ) => void,
    private readonly gate: GroupService["workflows"]["handleGate"],
    private readonly tick: (id: string) => void,
    private readonly park: (record: GroupWorkflowRunRecord, step: GroupWorkflowStepRecord) => void,
    private readonly retryAfterLoop: (
      record: GroupWorkflowRunRecord,
      step: GroupWorkflowStepRecord,
    ) => boolean,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.scan(), 1_000);
    this.timer.unref();
  }

  settled(run: Run) {
    if (!run.taskId || this.service.signal.aborted) return;
    const step = this.repo.byTask(run.taskId);
    if (!step) return;
    // B22: a blocked step's decision card is refreshed in place when its run ends. Continuation
    // runs carry a different run id, so the step is matched by task, not executionRunId.
    if (step.status === "blocked") {
      this.tick(step.workflowRunId);
      return;
    }
    if (step.status !== "running") return;
    this.reconcile(step);
  }

  private scan() {
    if (this.service.signal.aborted) return;
    try {
      const page = this.repo.running(this.cursor);
      for (const step of page) {
        try {
          this.reconcile(step);
        } catch {
          this.service.deps.logger.warn(
            JSON.stringify({
              module: "group-workflow",
              event: "reconcile_deferred",
              workflowRunId: step.workflowRunId,
              stepId: step.stepId,
            }),
          );
        }
      }
      const last = page.at(-1);
      this.cursor = page.length === 50 && last ? [last.workflowRunId, last.stepId] : ["", ""];
      const active = this.repo.active(this.activeCursor);
      for (const record of active) this.tick(record.id);
      this.activeCursor = active.length === 100 ? active.at(-1)?.id : undefined;
    } catch {
      this.cursor = ["", ""];
      this.service.deps.logger.warn("Group workflow reconciliation scan deferred");
    }
  }

  private reconcile(step: GroupWorkflowStepRecord) {
    const record = this.repo.get(step.workflowRunId);
    if (!record || !["running", "waiting"].includes(record.status)) return;
    const execution = stepExecution(this.service, record, step);
    if (execution?.waiting) return;
    const run = execution?.run;
    if (pendingStepQuestion(this.service, run)) return;
    if (run && ["queued", "running", "waiting", "stopping"].includes(run.status)) return;
    if (run?.status !== "done") {
      // Maintainers 2026-11-20: the group's pause stopped this run; that is not a failed attempt.
      if (run?.status === "aborted" && this.service.pausedFor(record.groupId)) {
        this.park(record, step);
        return;
      }
      const reason = stepFailureReason(this.service, run, "execution_interrupted");
      if (reason === "repeated_operation" && this.retryAfterLoop(record, step)) return;
      this.block(record, step, reason);
      return;
    }
    if (this.service.cycles.get(record.groupId).cycleId !== record.cycleId) {
      this.block(record, step, "cycle_replaced");
      return;
    }
    const task = step.taskId ? this.service.tasks.get(step.taskId) : undefined;
    if (task?.status !== "done") {
      // A parent can end while execution children/continuations still own the task. The
      // summary continuation hangs off the budget root, not this run; it is found by its task.
      if (
        task &&
        (this.service.tasks.hasPendingChildren(task.id) ||
          this.service.runs.hasActiveChild(run.id) ||
          this.service.runs.hasActiveForTask(task.id, run.id) ||
          this.service.deps.local.tasks.continuations.hasPending(run.conversationId))
      )
        return;
      this.block(record, step, stepFailureReason(this.service, run, "task_not_completed"));
      return;
    }
    const gate = this.service.handoffs.gate(task, run.id);
    if (gate.kind !== "wait" && gate.kind !== "plain") this.gate(task.id, gate, run.id);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
