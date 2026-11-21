import {
  type GroupWorkflowDecision,
  type KernelMethodParams,
  RpcError,
} from "@pibot/protocol-base";
import { type GroupWorkflowRunRecord, MessagesRepo, transaction } from "@pibot/storage";
import { assertPlanWorkplace } from "./group-plan-workplace.ts";
import { decisionText } from "./group-workflow-decision-text.ts";
import { pendingManualReviews } from "./group-workflow-manual-evidence.ts";
import { decisionOf, type WorkflowEngine, workflowOf } from "./group-workflow-snapshot.ts";

/** No new execution owner: the scheduler persists one final human gate in its existing snapshot. */
export class GroupWorkflowManualReview {
  constructor(private readonly engine: WorkflowEngine) {}

  /** Called only once all executable steps settled. A waiting gate survives missed UI events. */
  wait(record: GroupWorkflowRunRecord) {
    const { service, repo } = this.engine;
    let created = false;
    const waiting = transaction(service.deps.db, () => {
      const latest = repo.get(record.id);
      if (!latest || !["running", "waiting"].includes(latest.status)) return true;
      const reviewSteps = pendingManualReviews(service, latest);
      const first = reviewSteps[0];
      if (!first) return false;
      const workflow = workflowOf(latest);
      const messages = new MessagesRepo(service.deps.db);
      const existing = workflow.manualReviewMessageId
        ? messages.get(workflow.manualReviewMessageId)
        : undefined;
      if (existing) return true;
      const decision: GroupWorkflowDecision = {
        groupId: latest.groupId,
        workflowRunId: latest.id,
        stepId: first.stepId,
        title: workflow.name,
        ownerBotId: latest.coordinatorBotId,
        attempt: first.attempt,
        state: "pending",
        confirmationRequired: true,
        reasonCode: "plan_manual_review",
        reviewSteps,
      };
      const message = messages.create({
        conversationId: service.active(latest.groupId).conversationId,
        botId: latest.coordinatorBotId,
        role: "assistant",
        status: "done",
        content: service.deps.redactor.redact(
          decisionText(decision, service.deps.chat.currentLanguage()),
        ),
        usage: { groupWorkflowDecision: decision },
      });
      repo.updateWorkflow(latest.id, {
        ...(latest.workflow as object),
        manualReviewMessageId: message.id,
      });
      repo.updateRun(latest.id, "waiting");
      this.engine.audit(latest, "group.workflow.disposition", "Plan awaits final human review", {
        actor: "system",
        reasonCode: "plan_manual_review",
        entryCount: reviewSteps.length,
      });
      created = true;
      return true;
    });
    if (created) service.changed(record.groupId, "updated");
    return waiting;
  }

  resolve(params: KernelMethodParams["groups.workflow.resolve"]) {
    const { service, repo } = this.engine;
    const record = repo.get(params.workflowRunId);
    if (!record || record.groupId !== params.groupId) return;
    const messageId = workflowOf(record).manualReviewMessageId;
    if (!messageId) return;
    const messages = new MessagesRepo(service.deps.db);
    const message = messages.get(messageId);
    const decision = decisionOf(message?.usage);
    const reviewSteps = decision?.reviewSteps;
    if (!message || !decision || !reviewSteps || decision.stepId !== params.stepId) return;
    service.active(record.groupId);
    if (params.action !== "accept")
      throw new RpcError(-32602, "group_workflow_confirmation_unavailable");
    if (decision.state === "resolved" && decision.resolution === "accept")
      return { ok: true as const };
    assertPlanWorkplace(service, record.id);
    if (
      this.engine.closed ||
      service.deps.local.shutdown.signal.aborted ||
      record.status !== "waiting" ||
      service.cycles.get(record.groupId).cycleId !== record.cycleId ||
      JSON.stringify(pendingManualReviews(service, record)) !== JSON.stringify(decision.reviewSteps)
    )
      throw new RpcError(-32602, "group_workflow_confirmation_unavailable");
    transaction(service.deps.db, () => {
      // No await between the identity checks and commit; human acceptance never replays a tool.
      for (const step of reviewSteps) {
        const child = service.runs.get(step.executionRunId);
        if (
          service.tasks.get(step.taskId)?.status !== "done" ||
          child?.status !== "done" ||
          child.taskId !== step.taskId ||
          child.groupId !== record.groupId ||
          child.cycleId !== record.cycleId ||
          service.runs.hasActiveForTask(step.taskId, step.executionRunId)
        )
          throw new RpcError(-32602, "group_workflow_confirmation_unavailable");
        service.handoffs.repo.confirmByUser(step.taskId);
        service.handoffs.repo.setState(step.taskId, "met");
        this.engine.audit(record, "group.workflow.disposition", "Human acceptance confirmed", {
          actor: "user",
          reasonCode: "user_confirmed",
          stepId: step.stepId,
          taskId: step.taskId,
        });
      }
      const resolved: GroupWorkflowDecision = {
        ...decision,
        state: "resolved",
        resolution: "accept",
      };
      messages.update(messageId, {
        content: service.deps.redactor.redact(
          decisionText(resolved, service.deps.chat.currentLanguage()),
        ),
        usage: { ...(message.usage as object), groupWorkflowDecision: resolved },
      });
      repo.updateRun(record.id, "running");
    });
    service.changed(record.groupId, "updated");
    this.engine.schedule(record.id);
    return { ok: true as const };
  }
}
