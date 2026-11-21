import { explainPolicyResult, type PolicyResult } from "@pibot/policy";
import { type PermissionsSettings, RpcError } from "@pibot/protocol-base";
import { BotsRepo, ConversationsRepo, GroupsRepo } from "@pibot/storage";
import type { LocalService } from "../local-service.ts";
import type { ToolRunContext } from "./local-types.ts";

/** Group permission settings never depend on a member's DM settings. */
export function runPermissionScope(
  local: LocalService,
  context: Partial<ToolRunContext> & { botId: string },
) {
  const source = context.executionTaskId
    ? local.taskAuthority.source(context as ToolRunContext)
    : context;
  if (!source.groupId || context.routineRunId || context.routineSource) return undefined;
  const group = new GroupsRepo(local.deps.db).get(source.groupId);
  const conversation = source.conversationId
    ? new ConversationsRepo(local.deps.db).get(source.conversationId)
    : undefined;
  const bot = new BotsRepo(local.deps.db).get(context.botId);
  if (
    !group ||
    !bot ||
    bot.archivedAt ||
    !conversation ||
    conversation.archivedAt ||
    conversation.groupId !== group.id ||
    !group.members.some((member) => member.botId === context.botId)
  )
    throw new RpcError(-32602, "group_permission_scope_changed");
  return group.id;
}

export function runPermissions(
  local: LocalService,
  context: Partial<ToolRunContext> & { botId: string },
): PermissionsSettings {
  const groupId = runPermissionScope(local, context);
  return groupId
    ? local.permissions.effectiveGroup(groupId)
    : local.permissions.effective(context.botId);
}

/** Provenance is read from trusted settings owners, never inferred from matching values. */
export function runPermissionSources(local: LocalService, context: ToolRunContext) {
  const groupId = runPermissionScope(local, context);
  return local.permissions.sources(context.botId, groupId);
}

/** Scope selection and frozen authority stay in brain; the policy core has no repositories. */
export function explainRunScope(
  local: LocalService,
  context: ToolRunContext,
  result: PolicyResult,
) {
  if (runPermissionScope(local, context))
    result = explainPolicyResult(result, "boundary", "group_permission_scope", "narrow");
  if (local.taskAuthority.hasAuthority(context))
    result = explainPolicyResult(result, "boundary", "task_frozen_permissions", "narrow");
  return result;
}
