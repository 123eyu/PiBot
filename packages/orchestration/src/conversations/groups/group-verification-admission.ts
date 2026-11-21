import { randomUUID } from "node:crypto";
import { groupWorkplace, redactValue, workspaceFiles } from "@pibot/brain/orchestration-kit";
import {
  type GroupPlan,
  GroupPlanCardSchema,
  type GroupVerification,
  RpcError,
  type Run,
} from "@pibot/protocol-base";
import { preparePlanDelivery } from "./group-plan-delivery.ts";
import { validateGroupPlan } from "./group-plan-validation.ts";
import type { GroupService } from "./group-service.ts";
import { implementationAuthors, verificationMembers } from "./group-verification-facts.ts";

export async function verificationCard(
  service: GroupService,
  source: Run,
  plan: GroupPlan,
  facts: GroupVerification,
  budgetUsd: number | null,
  signal: AbortSignal,
) {
  if (!source.groupId || !source.cycleId) throw new RpcError(-32602, "group_plan_scope_invalid");
  const group = service.active(source.groupId, source.botId);
  const place = await groupWorkplace(service.deps.local, source.botId, group, signal);
  const access = workspaceFiles(service.deps.local, place.boundary);
  if (
    place.cwd !== facts.workspaceRoot ||
    (group.workspaceRevision ?? 0) !== facts.workspaceRevision ||
    (access.location?.target ?? "local") !== facts.target ||
    access.revision !== facts.revision
  )
    throw new RpcError(-32602, "group_plan_workplace_changed");
  const normalized = await preparePlanDelivery(plan, place.cwd, signal, undefined, access);
  if (normalized.issues) throw new RpcError(-32602, "group_plan_workplace_changed");
  const members = verificationMembers(service, group);
  const ready = service.deps.local.externalAgentProvider?.stepReadiness;
  const raw = validateGroupPlan(normalized.value, members, ready, implementationAuthors(facts));
  if (!raw.ok) throw new RpcError(-32602, raw.issues[0]?.code ?? "group_plan_admission_invalid");
  const checked = validateGroupPlan(
    redactValue(raw.plan, service.deps.redactor),
    members,
    ready,
    implementationAuthors(facts),
  );
  if (!checked.ok)
    throw new RpcError(-32602, checked.issues[0]?.code ?? "group_plan_admission_invalid");
  return GroupPlanCardSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    groupId: group.id,
    originRunId: source.id,
    cycleId: source.cycleId,
    budgetRootRunId: service.deps.local.tasks.budgetRoot(source),
    budgetUsd,
    verification: redactValue(facts, service.deps.redactor),
    plan: checked.plan,
    owners: checked.owners,
    delivery: redactValue(normalized.delivery, service.deps.redactor),
    status: "ready",
    confirmedByUser: false,
  });
}
