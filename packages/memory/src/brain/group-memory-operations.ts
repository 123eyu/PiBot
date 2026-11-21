import type { DatabaseSync } from "node:sqlite";
import { type BrainRedactor, requireGroupMember, type ToolRunContext } from "@pibot/brain/kit";
import {
  type KernelEvents,
  type KernelMethods,
  type Memory,
  type Peer,
  RpcError,
} from "@pibot/protocol-base";
import {
  AuditRepo,
  GroupMemoryRepo,
  MemoryUndoRepo,
  memoryStatus,
  transaction,
} from "@pibot/storage";
import { type MemoryToolInput, noteValue } from "./memory-input.ts";

interface Dependencies {
  db: DatabaseSync;
  peer: Peer<typeof KernelMethods, typeof KernelEvents>;
  redactor: BrainRedactor;
  write<T>(action: () => T): T;
  resolve(proposalId: string, accept: boolean): ReturnType<GroupMemoryRepo["resolve"]>;
}
/** Stateless group compatibility operations owned by the unified MemoryService. */
export function createGroupMemoryOperations(deps: Dependencies) {
  const undo = new MemoryUndoRepo(deps.db);
  return {
    groupRepo(groupId: string) {
      requireGroupMember({ db: deps.db }, groupId);
      return new GroupMemoryRepo(deps.db, groupId, (text) => deps.redactor.redact(text));
    },

    groupChanged(groupId: string) {
      deps.peer.emit("groups.resources.changed", {
        groupId,
        kind: "memory",
        needsOrganization: memoryStatus(deps.db, { scope: "group", ownerId: groupId })
          .needsOrganization,
      });
    },

    groupAudit(groupId: string, botId: string) {
      new AuditRepo(deps.db, deps.redactor).append({
        botId,
        kind: "memory.changed",
        summary: "Group memory changed / 群共享记忆变更",
        detail: { groupId, actor: "user" },
      });
    },

    /** Direct group writes still carry the group's audit; snapshots share the unified undo path. */
    groupAutomaticAudit(groupId: string, botId: string) {
      new AuditRepo(deps.db, deps.redactor).append({
        botId,
        kind: "memory.changed",
        summary: "Group memory saved automatically / 群共享记忆自动记下",
        detail: {
          groupId,
          memoryScope: "group",
          memoryOwnerId: groupId,
          reasonCode: "memory_automatic",
        },
      });
    },

    groupList(groupId: string) {
      const repo = this.groupRepo(groupId);
      return { memories: repo.list(), proposals: repo.proposals() };
    },

    groupSave(
      groupId: string,
      text: string,
      category: Memory["category"],
      id?: string,
      expectedUpdatedAt?: string,
    ) {
      const group = requireGroupMember({ db: deps.db }, groupId);
      const result = deps.write(() =>
        transaction(deps.db, () => {
          const memory = this.groupRepo(groupId).save(
            group.coordinatorBotId,
            text,
            category,
            id,
            null,
            expectedUpdatedAt,
          );
          this.groupAudit(groupId, group.coordinatorBotId);
          return memory;
        }),
      );
      this.groupChanged(groupId);
      return result;
    },

    groupRemove(groupId: string, id: string) {
      const group = requireGroupMember({ db: deps.db }, groupId);
      deps.write(() =>
        transaction(deps.db, () => {
          this.groupRepo(groupId).remove(id);
          this.groupAudit(groupId, group.coordinatorBotId);
        }),
      );
      this.groupChanged(groupId);
      return { ok: true as const };
    },

    groupResolve(groupId: string, id: string, accept: boolean) {
      if (!this.groupRepo(groupId).proposal(id))
        throw new RpcError(-32602, "group_memory_unavailable");
      return deps.resolve(id, accept);
    },

    groupExecute(
      context: Pick<ToolRunContext, "botId" | "messageId" | "groupId">,
      input: MemoryToolInput,
      automatic?: { assertCurrent(): void; audit(): void },
    ) {
      const groupId = context.groupId;
      if (!groupId) throw new RpcError(-32602, "group_resource_unavailable");
      requireGroupMember({ db: deps.db }, groupId, context.botId);
      const repo = this.groupRepo(groupId);
      const action =
        input.tool === "memory_add" ? "add" : input.tool === "memory_update" ? "update" : "remove";
      const id = input.tool === "memory_add" ? null : input.args.id;
      const prior = id ? repo.get(id) : undefined;
      const result = deps.write(() =>
        transaction(deps.db, () => {
          automatic?.assertCurrent();
          const proposal = repo.propose(context.botId, context.messageId, {
            action,
            memoryId: id,
            text:
              input.tool === "memory_remove"
                ? (prior?.text ?? "")
                : (input.args.text ?? prior?.text ?? ""),
            category:
              input.tool === "memory_remove"
                ? (prior?.category ?? null)
                : (input.args.category ?? prior?.category ?? null),
            ...(input.tool === "memory_remove"
              ? {}
              : {
                  // null is an explicit "clear": the proposal column's NULL already means
                  // "not mentioned", so the clear travels as an empty string.
                  why: noteValue(input.args.why, prior?.why),
                  how: noteValue(input.args.how, prior?.how),
                }),
          });
          if (automatic) {
            automatic.audit();
            const applied = repo.resolve(proposal.id, true);
            undo.set(
              context.botId,
              proposal.id,
              prior ? { ...prior, text: deps.redactor.redact(prior.text) } : null,
              applied.memory,
            );
            return applied;
          }
          return { proposal, memory: null };
        }),
      );
      this.groupChanged(groupId);
      return result;
    },
  };
}
