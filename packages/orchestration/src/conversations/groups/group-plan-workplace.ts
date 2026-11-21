import type { ToolRunContext } from "@pibot/brain/orchestration-kit";
import { GroupSchema, RpcError } from "@pibot/protocol-base";
import type { GroupService } from "./group-service.ts";

export const PlanWorkplaceSchema = GroupSchema.pick({
  folders: true,
  primaryFolderId: true,
  workspaceRevision: true,
})
  .extend({
    folders: GroupSchema.shape.folders.default([]),
    primaryFolderId: GroupSchema.shape.primaryFolderId.default(null),
    workspaceRevision: GroupSchema.shape.workspaceRevision.default(0),
  })
  .strip();

export function assertPlanWorkplace(service: GroupService, id: string) {
  if (service.workflows.repo.workplaceRevoked(id))
    throw new RpcError(-32602, "group_plan_workplace_revoked");
}

/** Only a program-bound step or replan may retain an earlier workspace; membership stays live. */
export function planWorkplaceGroup(service: GroupService, context: ToolRunContext) {
  if (!context.groupId) return undefined;
  const source = service.deps.local.tasks.hasAuthority(context)
    ? service.deps.local.tasks.source(context)
    : context;
  const step = source.taskId
    ? service.handoffs.repo.get(source.taskId)?.spec.workflowStep
    : undefined;
  let record = step
    ? service.workflows.repo.get(step.workflowRunId)
    : service.workflows.repo.replanning(source.runId);
  if (!record) {
    const run = service.runs.get(source.runId);
    const active = run?.cycleId
      ? service.workflows.repo.activePlan(context.groupId, run.cycleId)
      : undefined;
    if (active?.budgetRootRunId === source.runId) record = active;
  }
  if (!record || record.groupId !== context.groupId) return undefined;
  assertPlanWorkplace(service, record.id);
  const group = service.groups.get(context.groupId);
  if (!group) return undefined;
  const snapshot = (record.workflow as { workplace?: unknown }).workplace;
  return snapshot ? { ...group, ...PlanWorkplaceSchema.parse(snapshot) } : undefined;
}
