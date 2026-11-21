import type { RegisterRpc } from "@pibot/brain/kit";
import type { MemoryService } from "./memory-service.ts";

export function registerGroupMemoryRpc(handle: RegisterRpc, memory: MemoryService) {
  handle("groups.memory.list", async ({ groupId }) => memory.groupList(groupId));
  handle("groups.memory.save", async ({ groupId, id, text, category, expectedUpdatedAt }) =>
    memory.groupSave(groupId, text, category, id, expectedUpdatedAt),
  );
  handle("groups.memory.remove", async ({ groupId, id }) => memory.groupRemove(groupId, id));
  handle("groups.memory.resolve", async ({ groupId, proposalId, accept }) =>
    memory.groupResolve(groupId, proposalId, accept),
  );
}
