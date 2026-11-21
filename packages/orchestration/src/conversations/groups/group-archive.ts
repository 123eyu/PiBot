import { RpcError } from "@pibot/protocol-base";
import { transaction } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

export async function archiveGroup(service: GroupService, groupId: string) {
  const group = service.groups.get(groupId);
  if (!group) throw new RpcError(-32602, "Unknown group");
  if (group.archivedAt) return group;
  // Keep the group exclusive until real background and queue owners have drained.
  return service.mutate(
    groupId,
    () =>
      transaction(service.deps.db, () => {
        for (;;) {
          const page = service.tasks.listForGroup(groupId, { limit: 50 }, "open");
          if (!page.length) break;
          for (const task of page) {
            service.tasks.finish(task.id, task.assigneeBotId, "cancelled");
            service.cycles.claimWake(task.id);
          }
        }
        service.cycles.reset(groupId);
        const result = service.groups.setArchived(groupId, true);
        service.deps.local.approvals.audit.append({
          botId: group.coordinatorBotId,
          kind: "execution.todo.changed",
          summary: "Group archived / 群已归档",
          detail: { groupId, reasonCode: "group_archived", actor: "user" },
        });
        return result;
      }),
    "deleted",
    false,
    false,
    false,
    async () => {
      let cursor: string | undefined;
      for (;;) {
        const page = service.workflows.repo.active(cursor);
        for (const record of page)
          if (record.groupId === groupId)
            service.workflows.progress.stop(record, "group_archived", "user");
        if (page.length < 100) break;
        cursor = page.at(-1)?.id;
      }
      await service.workflows.progress.settled();
      await service.deps.local.background.stopWhere(
        (row) => row.groupId === groupId,
        "chat_deleted",
      );
      let after = "";
      for (;;) {
        const page = service.groups.conversationIds(groupId, after);
        if (page.some((id) => service.deps.local.background.topicBusy(id)))
          throw new RpcError(-32011, "group_archive_draining");
        if (page.length < 50) break;
        after = page.at(-1) as string;
      }
      await service.files.drainGroup(groupId);
    },
  );
}
export async function restoreGroup(service: GroupService, groupId: string) {
  const group = service.groups.get(groupId);
  if (!group) throw new RpcError(-32602, "Unknown group");
  if (!group.archivedAt) return group;
  return service.mutate(
    groupId,
    () =>
      transaction(service.deps.db, () => {
        const result = service.groups.setArchived(groupId, false);
        service.deps.local.approvals.audit.append({
          botId: group.coordinatorBotId,
          kind: "execution.todo.changed",
          summary: "Group restored / 群已恢复",
          detail: { groupId, reasonCode: "group_restored", actor: "user" },
        });
        return result;
      }),
    "updated",
  );
}
