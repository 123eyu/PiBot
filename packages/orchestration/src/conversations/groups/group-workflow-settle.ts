// A retry consumes its report allowance only when the durable step is actually redispatched.
import type { WorkflowStep } from "@pibot/protocol-base";
import {
  type GroupWorkflowRunRecord,
  type GroupWorkflowStepRecord,
  transaction,
} from "@pibot/storage";
import type { HandoffGate } from "./group-handoffs.ts";
import { pendingStepQuestion } from "./group-step-question.ts";
import { handoffReportVerdict } from "./group-verdict-results.ts";
import { confirmationRequired, deferredManualConfirmation } from "./group-workflow-brief.ts";
import { settleDeliveryReview } from "./group-workflow-delivery-review.ts";
import { stepExecution } from "./group-workflow-execution.ts";
import { progressOf } from "./group-workflow-progress.ts";
import { stepDeliverables, type WorkflowEngine, workflowOf } from "./group-workflow-snapshot.ts";

/** Settles a finished step from its hand-off gate, and restores in-flight steps after restart. */
export class GroupWorkflowSettlement {
  constructor(private readonly engine: WorkflowEngine) {}

  /** Called after the existing hand-off checker has a stable result. */
  handleGate(
    taskId: string,
    gate: Exclude<HandoffGate, { kind: "plain" | "wait" }>,
    finishedRunId: string,
  ) {
    const { service, repo, progress } = this.engine;
    if (this.engine.closed || service.deps.local.shutdown.signal.aborted)
      return !!repo.byTask(taskId);
    const current = repo.byTask(taskId);
    if (!current) return false;
    if (current.status !== "running") return true;
    const record = repo.get(current.workflowRunId);
    if (!record || !["running", "waiting"].includes(record.status)) return true;
    const accepts = (state: GroupWorkflowStepRecord, plan: GroupWorkflowRunRecord) => {
      const execution = stepExecution(service, plan, state);
      return (
        !execution?.waiting &&
        execution?.run?.id === finishedRunId &&
        execution.run.status === "done" &&
        service.cycles.get(plan.groupId).cycleId === plan.cycleId &&
        service.tasks.get(taskId)?.status === "done" &&
        gate.record.taskId === taskId
      );
    };
    if (!accepts(current, record)) return true;
    const workflow = workflowOf(record);
    const definition = workflow.contract.steps?.find((step) => step.id === current.stepId);
    if (!definition) return true;
    if (
      gate.kind === "wake" &&
      confirmationRequired(gate.record) &&
      !deferredManualConfirmation(gate.record)
    ) {
      transaction(service.deps.db, () => {
        const report = handoffReportVerdict(gate.record.result?.items ?? []);
        if (report) {
          const ledger = progressOf(record);
          progress.save(record, {
            ...ledger,
            verdicts: { ...ledger.verdicts, [current.stepId]: report },
          });
        }
        this.engine.block(record, definition, current, "verification_required");
      });
      return true;
    }
    const failed = gate.kind === "return" || gate.kind === "stop";
    const failures = gate.record.result?.items.filter((item) => item.status === "fail") ?? [];
    const missingVerdict = failures.some((item) => item.reason === "verdict_missing");
    const onlyMissingVerdict =
      missingVerdict && failures.every((item) => item.reason === "verdict_missing");
    const maxFixRounds = definition.maxFixRounds ?? workflow.contract.maxFixRounds;
    const settled = transaction(service.deps.db, () => {
      const latest = repo.byTask(taskId);
      const latestRun = repo.get(record.id);
      if (
        latest?.status !== "running" ||
        latest.executionRunId !== current.executionRunId ||
        latest.attempt !== current.attempt ||
        !latestRun ||
        !["running", "waiting"].includes(latestRun.status) ||
        !accepts(latest, latestRun)
      )
        return false;
      const before = progressOf(latestRun);
      const resubmitVerdict = missingVerdict && !before.verdictResubmissions[current.stepId];
      const ordinaryAttempts =
        current.attempt - (before.verdictResubmissions[current.stepId] ? 1 : 0);
      const canRetry = resubmitVerdict || (!onlyMissingVerdict && ordinaryAttempts < maxFixRounds);
      // Interactive draining may already own the ordinary completion wake. Only the durable
      // step transition owns DAG settlement; consuming a wake is not proof of that transition.
      service.cycles.claimWake(taskId);
      const ledger =
        workflow.source.kind === "dynamic"
          ? progress.observe(latestRun, { ...latest, executionRunId: finishedRunId }, failed)
          : undefined;
      if (!failed) {
        const report = handoffReportVerdict(gate.record.result?.items ?? []);
        if (workflow.source.kind !== "dynamic" && report) {
          const latestProgress = progressOf(latestRun);
          progress.save(latestRun, {
            ...latestProgress,
            verdicts: { ...latestProgress.verdicts, [current.stepId]: report },
          });
        }
        // Step execution can advance while human acceptance remains recorded in the handoff.
        if (!deferredManualConfirmation(gate.record)) service.handoffs.repo.setState(taskId, "met");
        repo.updateStep(record.id, current.stepId, {
          status: "passed",
          executionRunId: finishedRunId,
          deliverables: stepDeliverables(
            definition,
            service.tasks.get(taskId)?.summary ?? "",
            gate.record.result?.artifacts ?? [],
          ),
        });
        if (ledger?.review) {
          const latestProgress = progressOf(repo.get(record.id) ?? latestRun);
          progress.save(latestRun, {
            ...latestProgress,
            review: settleDeliveryReview(
              service,
              latestRun,
              repo.steps(record.id),
              ledger.review,
              current.stepId,
              finishedRunId,
            ),
          });
        }
      } else if (ledger?.review?.supplementStepId === current.stepId) {
        service.handoffs.repo.setState(taskId, "unmet");
        repo.updateStep(record.id, current.stepId, {
          status: "blocked",
          executionRunId: finishedRunId,
        });
      } else if (canRetry && !ledger?.requested) {
        service.handoffs.repo.setState(taskId, "returned");
        repo.updateStep(record.id, current.stepId, {
          status: "ready",
          attempt: current.attempt + 1,
          taskId: null,
          executionRunId: finishedRunId,
        });
        if (resubmitVerdict) {
          const latestProgress = progressOf(repo.get(record.id) ?? latestRun);
          progress.save(latestRun, {
            ...latestProgress,
            verdictResubmissions: {
              ...latestProgress.verdictResubmissions,
              [current.stepId]: true,
            },
          });
        }
      } else {
        service.handoffs.repo.setState(taskId, "unmet");
        repo.updateStep(record.id, current.stepId, {
          status: "blocked",
          executionRunId: finishedRunId,
        });
        repo.updateRun(record.id, "waiting");
        if (workflow.source.kind === "dynamic") progress.request(latestRun);
      }
      this.engine.audit(
        record,
        failed ? "group.workflow.step_failed" : "group.workflow.step_passed",
        failed
          ? "Group workflow step failed / 群工作流步骤失败"
          : "Group workflow step passed / 群工作流步骤通过",
        { stepId: current.stepId, attempt: current.attempt, taskId, childRunId: finishedRunId },
      );
      return true;
    });
    if (!settled) return true;
    service.handoffs.settled(taskId);
    if (!failed) this.engine.requestMerge(record.id, current.stepId);
    if (
      failed &&
      progressOf(repo.get(record.id) ?? record).review?.supplementStepId === current.stepId
    ) {
      progress.stop(record, "supplement_unmet");
      return true;
    }
    if (failed && repo.byTask(taskId)?.status === "blocked" && workflow.source.kind !== "dynamic")
      this.engine.createDecision(record, definition, current.attempt);
    // The group hears the transition from the program, whether it passed or stalled.
    this.engine.announce(this.engine.repo.get(record.id) ?? record);
    this.engine.schedule(record.id);
    return true;
  }

  recover(record: GroupWorkflowRunRecord) {
    const { service, repo, progress } = this.engine;
    const interrupted: { state: GroupWorkflowStepRecord; definition: WorkflowStep }[] = [];
    let disposed = false;
    const workflow = workflowOf(record);
    transaction(service.deps.db, () => {
      for (const state of repo.steps(record.id)) {
        const definition = workflow.contract.steps?.find((step) => step.id === state.stepId);
        if (state.status === "blocked" && !state.decisionMessageId && definition) {
          // A stuck dynamic step is the coordinator's to dispose of first. Restoring the
          // pending disposition keeps that channel open; a user card built here would then block
          // every later replan (`replan()` returns once a blocked step owns a card).
          if (workflow.source.kind === "dynamic") {
            disposed = true;
            continue;
          }
          this.engine.createDecision(record, definition, state.attempt);
          continue;
        }
        if (state.status !== "running") continue;
        const run = state.executionRunId ? service.runs.get(state.executionRunId) : undefined;
        if (pendingStepQuestion(service, run)) continue;
        // A terminal child may have finished just before the process died but before its handoff
        // gate committed. Never guess that result on recovery: surface the same explicit user
        // disposition as every other interrupted step.
        if (run && ["queued", "running", "waiting", "stopping"].includes(run.status)) continue;
        if (!definition) continue;
        repo.updateStep(record.id, state.stepId, { status: "blocked" });
        repo.updateRun(record.id, "waiting");
        interrupted.push({ state, definition });
      }
      if (disposed) repo.updateRun(record.id, "waiting");
    });
    if (disposed) {
      const latest = repo.get(record.id) ?? record;
      const ledger = progressOf(latest);
      // Keep the durable wake identity: even a terminal run must be classified by the replanner.
      progress.save(latest, { ...ledger, requested: true });
    }
    for (const { state, definition } of interrupted) {
      this.engine.createDecision(record, definition, state.attempt, "restart_interrupted");
      this.engine.audit(
        record,
        "group.workflow.step_blocked",
        "Interrupted group workflow step blocked / 中断的群工作流步骤已阻塞",
        {
          actor: "system",
          stepId: state.stepId,
          attempt: state.attempt,
          reasonCode: "restart_interrupted",
          ...(state.taskId ? { taskId: state.taskId } : {}),
          ...(state.executionRunId ? { childRunId: state.executionRunId } : {}),
        },
      );
    }
    this.engine.audit(
      record,
      "group.workflow.recovered",
      "Group workflow recovered / 群工作流已恢复",
      {
        actor: "system",
      },
    );
    this.engine.schedule(record.id);
  }
}
