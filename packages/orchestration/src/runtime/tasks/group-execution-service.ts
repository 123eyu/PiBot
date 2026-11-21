import type { KernelRegisterRpc, LocalService } from "@pibot/brain/orchestration-kit";
import {
  type ExecutionLimits,
  type ExecutionMode,
  type GroupExecutionSettings,
  RpcError,
} from "@pibot/protocol-base";
import {
  ConversationsRepo,
  ExecutionConflictError,
  GroupCyclesRepo,
  GroupExecutionLimitsRepo,
  GroupsRepo,
  transaction,
} from "@pibot/storage";

export class GroupExecutionService {
  readonly repo: GroupExecutionLimitsRepo;
  constructor(private readonly local: LocalService) {
    this.repo = new GroupExecutionLimitsRepo(local.deps.db);
  }
  private group(groupId: string) {
    const group = new GroupsRepo(this.local.deps.db).get(groupId);
    if (!group) throw new RpcError(-32602, "execution_unavailable");
    return group;
  }
  get(groupId: string) {
    this.group(groupId);
    return this.repo.get(groupId);
  }
  set(
    groupId: string,
    expectedVersion: number,
    change: { limits?: ExecutionLimits; mode?: ExecutionMode },
  ) {
    if (change.mode === undefined && change.limits === undefined)
      throw new RpcError(-32602, "group_execution_settings_empty");
    const group = this.group(groupId);
    let result: GroupExecutionSettings;
    try {
      result = transaction(this.local.deps.db, () => {
        const next = this.repo.set(groupId, expectedVersion, change);
        this.local.approvals.audit.append({
          botId: group.coordinatorBotId,
          kind: "execution.changed",
          summary: "Shared group execution settings changed / 群共享执行设置已更新",
          detail: {
            groupId,
            actor: "user",
            reasonCode:
              change.mode !== undefined ? `group_mode_${next.mode}` : "group_limits_updated",
          },
        });
        return next;
      });
    } catch (error) {
      if (error instanceof ExecutionConflictError)
        throw new RpcError(-32602, "execution_version_changed");
      throw error;
    }
    this.local.deps.peer.emit("groups.execution.changed", result);
    return result;
  }
  usage(groupId: string, conversationId: string, expectedCycleId?: string | null) {
    const group = this.group(groupId),
      conversation = new ConversationsRepo(this.local.deps.db).get(conversationId);
    if (group.conversationId !== conversationId || conversation?.archivedAt)
      throw new RpcError(-32602, "group_topic_stale");
    const cycleId = new GroupCyclesRepo(this.local.deps.db).get(groupId).cycleId;
    if (expectedCycleId !== undefined && expectedCycleId !== cycleId)
      throw new RpcError(-32602, "group_cycle_stale");
    return this.repo.usage(groupId, conversationId, cycleId);
  }
}
export function registerGroupExecutionRpc(
  handle: KernelRegisterRpc,
  service: GroupExecutionService,
) {
  handle("groups.execution.get", async ({ groupId }) => service.get(groupId));
  handle("groups.execution.set", async ({ groupId, expectedVersion, limits, mode }) =>
    service.set(groupId, expectedVersion, { limits, mode }),
  );
  handle("groups.execution.usage", async ({ groupId, conversationId, cycleId }) =>
    service.usage(groupId, conversationId, cycleId),
  );
}
