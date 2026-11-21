import { type GroupWorkflowDecision, RpcError, type WorkflowStep } from "@pibot/protocol-base";
import type { GroupWorkflowRunRecord } from "@pibot/storage";
import { assertPlanWorkplace } from "./group-plan-workplace.ts";
import type { GroupService } from "./group-service.ts";
import { deferredManualConfirmation } from "./group-workflow-brief.ts";
import { planReplacementChain } from "./group-workflow-lineage.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";

const unavailable = () => new RpcError(-32602, "group_workflow_manual_evidence_unavailable");
const definition = ({ owner: _owner, ...step }: WorkflowStep) => JSON.stringify(step);

/** Inherited passed steps have no task ownership; trace evidence without restoring ownership. */
export function pendingManualReviews(service: GroupService, record: GroupWorkflowRunRecord) {
  const repo = service.workflows.repo;
  const states = repo.steps(record.id);
  if (!states.length || !states.every((step) => ["passed", "skipped"].includes(step.status)))
    return [];
  const plans = planReplacementChain(service, record).map((item) => {
    assertPlanWorkplace(service, item.id);
    return {
      record: item,
      states: new Map(repo.steps(item.id).map((step) => [step.stepId, step])),
      definitions: new Map(workflowOf(item).contract.steps?.map((step) => [step.id, step])),
    };
  });
  const reviews: NonNullable<GroupWorkflowDecision["reviewSteps"]> = [];
  for (const current of states) {
    const currentDefinition = plans[0]?.definitions.get(current.stepId);
    if (
      current.status !== "passed" ||
      !currentDefinition ||
      (current.taskId && !currentDefinition.acceptance.some((item) => item.check === "manual"))
    )
      continue;
    let found = false;
    for (const plan of plans) {
      const step = plan.states.get(current.stepId);
      const original = plan.definitions.get(current.stepId);
      if (
        step?.status !== "passed" ||
        !step.executionRunId ||
        step.executionRunId !== current.executionRunId ||
        step.ownerBotId !== current.ownerBotId ||
        !original ||
        definition(original) !== definition(currentDefinition)
      )
        throw unavailable();
      if (!step.taskId) continue;
      const handoff = service.handoffs.repo.get(step.taskId);
      const child = service.runs.get(step.executionRunId);
      const task = service.tasks.get(step.taskId);
      if (
        !handoff?.result ||
        handoff.spec.workflowStep?.workflowRunId !== plan.record.id ||
        handoff.spec.workflowStep.stepId !== step.stepId ||
        !child ||
        child.taskId !== step.taskId ||
        child.botId !== step.ownerBotId ||
        child.groupId !== record.groupId ||
        child.cycleId !== record.cycleId ||
        task?.groupId !== record.groupId ||
        task.assigneeBotId !== step.ownerBotId
      )
        throw unavailable();
      if (!handoff.spec.acceptance.some((item) => item.check === "manual")) {
        found = true;
        break;
      }
      if (deferredManualConfirmation(handoff))
        reviews.push({
          stepId: current.stepId,
          title: currentDefinition.title,
          taskId: step.taskId,
          executionRunId: step.executionRunId,
          attempt: step.attempt,
          checks: handoff.spec.acceptance
            .filter((item) => item.check === "manual")
            .map((item) => item.text ?? item.id),
        });
      else if (!handoff.result.userResolved) throw unavailable();
      found = true;
      break;
    }
    if (!found) throw unavailable();
  }
  return reviews;
}
