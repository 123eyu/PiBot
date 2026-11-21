import type { DatabaseSync } from "node:sqlite";
import type { Memory, MemoryProposal } from "@pibot/protocol-base";
import { MemoriesRepo } from "../bots/memory.ts";
import { transaction } from "../database/database.ts";

/** Compatibility adapter; group and private callers share the scoped repository. */
export class GroupMemoryRepo {
  private readonly repo: MemoriesRepo;
  constructor(
    private readonly db: DatabaseSync,
    readonly groupId: string,
    redact: (text: string) => string,
  ) {
    this.repo = new MemoriesRepo(db, redact, { scope: "group", ownerId: groupId });
  }
  list() {
    return this.repo.list(this.groupId);
  }
  get(id: string) {
    return this.repo.get(this.groupId, id);
  }
  save(
    botId: string,
    text: string,
    category: Memory["category"],
    id?: string,
    sourceMessageId: string | null = null,
    expectedUpdatedAt?: string,
  ): Memory {
    return transaction(this.db, () => {
      const before = id ? this.get(id) : undefined;
      if (id && !before) throw new TypeError("group_memory_unavailable");
      if (before && expectedUpdatedAt !== undefined && before.updatedAt !== expectedUpdatedAt)
        throw new TypeError("group_memory_conflict");
      return before
        ? (this.repo.update(botId, before.id, { text, category }) as Memory)
        : this.repo.add(botId, text, sourceMessageId, category);
    });
  }
  remove(id: string) {
    if (!this.repo.remove(this.groupId, id)) throw new TypeError("group_memory_unavailable");
  }
  proposals() {
    return this.repo.proposals(this.groupId, { limit: 100 });
  }
  proposal(id: string) {
    const p = this.repo.proposal(id);
    return p?.scope === "group" && p.ownerId === this.groupId ? p : undefined;
  }
  propose(
    botId: string,
    messageId: string,
    input: {
      action: Exclude<MemoryProposal["action"], "move">;
      memoryId: string | null;
      text: string;
      category: Memory["category"];
    },
  ) {
    return this.repo.propose(
      botId,
      input.text,
      messageId,
      { action: input.action, memoryId: input.memoryId },
      input.category,
    );
  }
  resolve(id: string, accept: boolean) {
    if (!this.proposal(id)) throw new TypeError("group_memory_unavailable");
    return this.repo.resolve(id, accept);
  }
}
