// Both in-run and final handoff checks resolve the same frozen workplace and provenance.
import {
  deliverySources,
  groupWorkplace,
  type WorkspaceFileAccess,
  workspaceFiles,
} from "@pibot/brain/orchestration-kit";
import { type GroupTask, RpcError } from "@pibot/protocol-base";
import type { HandoffRecord } from "@pibot/storage";
import { assertPlanWorkplace, PlanWorkplaceSchema } from "./group-plan-workplace.ts";
import type { GroupService } from "./group-service.ts";
import { workflowOf } from "./group-workflow-snapshot.ts";
import { stepProvenance } from "./group-workflow-sources.ts";

export async function prepareHandoffCheck(
  service: GroupService,
  task: GroupTask,
  record: HandoffRecord,
  runId: string,
  signal: AbortSignal,
  onStage?: (stage: "sources") => void,
) {
  const group = service.groups.get(task.groupId);
  const finished = service.runs.get(runId);
  if (
    !group ||
    !finished ||
    finished.taskId !== task.id ||
    finished.groupId !== task.groupId ||
    finished.botId !== task.assigneeBotId
  )
    throw new RpcError(-32602, "group_plan_workplace_changed");
  const step = record.spec.workflowStep;
  const plan = step ? service.workflows.repo.get(step.workflowRunId) : undefined;
  if (step && (!plan || plan.groupId !== task.groupId))
    throw new RpcError(-32602, "group_plan_workplace_changed");
  if (plan) assertPlanWorkplace(service, plan.id);
  const snapshot = plan ? workflowOf(plan)?.workplace : undefined;
  const frozen = snapshot ? { ...group, ...PlanWorkplaceSchema.parse(snapshot) } : group;
  const access = workspaceFiles(
    service.deps.local,
    (await groupWorkplace(service.deps.local, task.assigneeBotId, frozen, signal)).boundary,
  );
  const expected = record.spec.deliveryLocation;
  if (
    (expected?.location || access.remote) &&
    (expected?.location?.target !== access.location?.target ||
      expected?.workspaceRoot !== access.root ||
      expected?.workspaceRevision !== access.revision)
  )
    throw new RpcError(-32602, "group_plan_workplace_changed");
  onStage?.("sources");
  // Maintainers 2026-11-14: a task in its own workspace is judged there, before any merge.
  const judged = isolatedRecord(record, service.memberWorktrees.isolated(task.id), access);
  const sources = deliverySources(
    service.deps.db,
    runId,
    record.pipeline?.inputs,
    stepProvenance(service, runId, task.id),
    judged.spec.deliveryLocation?.workspaceRoot,
    access,
  );
  return { record: judged, sources };
}

/**
 * The same hand-off as seen from the member's own workspace: its folder and delivery root map
 * from the primary folder to the workspace, which mirrors it file for file.
 */
function isolatedRecord(
  record: HandoffRecord,
  isolated: { root: string; primary: string } | undefined,
  access: WorkspaceFileAccess,
): HandoffRecord {
  if (!isolated || !record.baseFolder) return record;
  const paths = access.paths;
  const relative = paths.relative(isolated.primary, record.baseFolder);
  if (relative.startsWith("..") || paths.isAbsolute(relative)) return record;
  const location = record.spec.deliveryLocation;
  return {
    ...record,
    baseFolder: paths.join(isolated.root, relative),
    spec: {
      ...record.spec,
      ...(location ? { deliveryLocation: { ...location, workspaceRoot: isolated.root } } : {}),
    },
  };
}
