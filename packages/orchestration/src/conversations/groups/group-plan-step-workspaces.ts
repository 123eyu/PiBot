import type { PlanStepWorkspace } from "@pibot/brain/orchestration-kit";
import type { WorkflowStep } from "@pibot/protocol-base";
import type { GroupWorkflowRunRecord, GroupWorkflowStepRecord } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";
import { summaryStep } from "./group-workflow-delivery-review.ts";
import type { StoredWorkflow } from "./group-workflow-snapshot.ts";

/**
 * Maintainers 2026-11-14: a writing step that can run at the same time as another writing step works
 * in its own workspace and the program merges it, so members no longer queue on one folder. A
 * step writes when it has deliverables and is not the coordinator's final summary (that one
 * reads the merged result). A step nothing can overlap with starts only after every ancestor is
 * merged and before any descendant, so it writes the real folder directly: isolation would only
 * add a merge, its approval and two sandboxed Git runs (measured ~20 s a step).
 */
export function workspaceSteps(
  record: GroupWorkflowRunRecord,
  workflow: StoredWorkflow,
  states: readonly GroupWorkflowStepRecord[],
): ReadonlySet<string> {
  const steps = workflow.contract.steps ?? [];
  const summary = summaryStep(record, workflow, states);
  const writing = steps.filter((step) => step.deliverables.length > 0 && step.id !== summary);
  if (writing.length < 2) return new Set();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const ancestors = new Map<string, Set<string>>();
  const above = (id: string): Set<string> => {
    const known = ancestors.get(id);
    if (known) return known;
    const found = new Set<string>();
    ancestors.set(id, found);
    for (const parent of byId.get(id)?.dependsOn ?? []) {
      found.add(parent);
      for (const item of above(parent)) found.add(item);
    }
    return found;
  };
  const independent = (a: WorkflowStep, b: WorkflowStep) =>
    a.id !== b.id && !above(a.id).has(b.id) && !above(b.id).has(a.id);
  return new Set(
    writing.filter((a) => writing.some((b) => independent(a, b))).map((step) => step.id),
  );
}

/** The task whose work a step row stands for; a replacement plan keeps only the run id. */
export function stepTaskId(service: GroupService, state: GroupWorkflowStepRecord) {
  if (state.taskId) return state.taskId;
  return state.executionRunId
    ? (service.runs.get(state.executionRunId)?.taskId ?? undefined)
    : undefined;
}

/** A step's result is in the shared folder: it never had a workspace, or that one is merged. */
export function stepMerged(service: GroupService, state: GroupWorkflowStepRecord) {
  if (state.status === "skipped") return true;
  const taskId = stepTaskId(service, state);
  const workspace = taskId ? service.memberWorktrees.workspace(taskId) : undefined;
  return !workspace || workspace.state === "integrated";
}

export function planStepWorkspace(
  record: GroupWorkflowRunRecord,
  workflow: StoredWorkflow,
): PlanStepWorkspace | undefined {
  const planKey = record.budgetRootRunId;
  return planKey ? { planKey, outputFolder: workflow.folder } : undefined;
}

/** The output folder as the member sees it from its own workspace (its working folder). */
export function workspaceFolder(workflow: StoredWorkflow, step: WorkflowStep) {
  const root =
    workflow.delivery?.workspaceRoot ??
    workflow.workplace?.folders?.find((item) => item.id === workflow.workplace?.primaryFolderId)
      ?.path;
  if (!root || !workflow.folder.startsWith(root)) return undefined;
  const relative = workflow.folder.slice(root.length).replace(/^[\\/]+/, "");
  return relative && !relative.split(/[\\/]/).includes("..") && step.deliverables.length
    ? relative
    : undefined;
}
