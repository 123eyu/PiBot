import { type GroupVerification, RpcError } from "@pibot/protocol-base";
import type { GroupWorkflowStepRecord } from "@pibot/storage";
import { stepMerged, stepTaskId } from "./group-plan-step-workspaces.ts";
import type { GroupService } from "./group-service.ts";
import { verificationFacts } from "./group-verification-facts.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";

export function uncoveredSteps(service: GroupService, workflowRunId: string) {
  const record = service.workflows.repo.get(workflowRunId);
  if (record?.status !== "passed") return [];
  const group = service.groups.get(record.groupId);
  if (!group) return [];
  const definitions = workflowOf(record).contract.steps ?? [];
  const states = service.workflows.repo.steps(record.id);
  if (states.some((state) => !stepMerged(service, state))) return [];
  const byId = new Map(definitions.map((step) => [step.id, step]));
  const covered = (id: string) => {
    const visit = (next: string, seen = new Set<string>()): boolean => {
      if (seen.has(next)) return false;
      seen.add(next);
      const definition = byId.get(next);
      return (
        !!definition &&
        (definition.dependsOn.includes(id) || definition.dependsOn.some((dep) => visit(dep, seen)))
      );
    };
    return definitions.some(
      (step) => step.acceptance.some((item) => item.check === "verdict") && visit(step.id),
    );
  };
  return states.filter(
    (state) =>
      state.status === "passed" &&
      !covered(state.stepId) &&
      !byId.get(state.stepId)?.acceptance.some((item) => item.check === "verdict"),
  );
}

async function stepFacts(
  service: GroupService,
  state: GroupWorkflowStepRecord,
  signal: AbortSignal,
) {
  const run = state.executionRunId ? service.runs.get(state.executionRunId) : undefined;
  if (!run) return;
  const facts = await verificationFacts(service, run, signal);
  if (facts) return facts;
  const taskId = stepTaskId(service, state);
  const merged = taskId ? service.memberWorktrees.integratedRoot?.(taskId) : undefined;
  if (!merged) return;
  // The capability alone proves the old isolated root was integrated into the selected folder.
  return verificationFacts(service, run, signal, merged);
}

export async function completedVerificationFacts(
  service: GroupService,
  workflowRunId: string,
  signal: AbortSignal,
): Promise<GroupVerification | undefined> {
  const record = service.workflows.repo.get(workflowRunId);
  const group = record ? service.groups.get(record.groupId) : undefined;
  const workflow = record ? workflowOf(record) : undefined;
  if (
    workflow?.workplaceRevoked ||
    (workflow?.workplace &&
      workflow.workplace.workspaceRevision !== (group?.workspaceRevision ?? 0))
  )
    throw new RpcError(-32602, "group_plan_workplace_changed");
  const contributions: { stepId: string; facts: GroupVerification }[] = [];
  for (const state of uncoveredSteps(service, workflowRunId)) {
    const facts = await stepFacts(service, state, signal);
    if (!facts) continue;
    const run = service.runs.get(facts.sourceRunId);
    if (
      !record ||
      !run ||
      run.groupId !== record.groupId ||
      run.cycleId !== record.cycleId ||
      service.deps.local.tasks.budgetRoot(run) !== record.budgetRootRunId
    )
      throw new RpcError(-32602, "group_plan_scope_invalid");
    contributions.push({ stepId: state.stepId, facts });
  }
  const first = contributions[0]?.facts;
  if (!first) return;
  const files = [...new Set(contributions.flatMap((item) => item.facts.files))];
  let size = 0;
  const selected: string[] = [];
  for (const file of files) {
    if (selected.length >= 500 || size + file.length > 16000) break;
    selected.push(file);
    size += file.length;
  }
  if (
    contributions.some(
      ({ facts }) =>
        facts.workspaceRoot !== first.workspaceRoot ||
        facts.target !== first.target ||
        facts.revision !== first.revision,
    )
  )
    throw new RpcError(-32602, "group_plan_workplace_changed");
  return {
    ...first,
    workflowRunId,
    files: selected,
    truncated: files.length > selected.length || contributions.some(({ facts }) => facts.truncated),
    sources: contributions.map(({ stepId, facts }) => ({
      stepId,
      runId: facts.sourceRunId,
      authorBotId: facts.authorBotId,
    })),
  };
}
