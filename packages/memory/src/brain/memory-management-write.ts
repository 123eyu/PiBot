import type { DatabaseSync } from "node:sqlite";
import type { BrainRedactor } from "@pibot/brain/kit";
import {
  type KernelEvents,
  type KernelMethodParams,
  type KernelMethods,
  type MemoryOwner,
  type Peer,
  RpcError,
} from "@pibot/protocol-base";
import {
  AuditRepo,
  MemoriesRepo,
  MemoryManagementRepo,
  MemoryUndoRepo,
  sameMemoryRevision,
  transaction,
} from "@pibot/storage";
import { memoryChanged } from "./memory-context.ts";

export function applyManagedMemory(
  db: DatabaseSync,
  peer: Peer<typeof KernelMethods, typeof KernelEvents>,
  redactor: BrainRedactor,
  owner: MemoryOwner,
  actor: string,
  change: KernelMethodParams["memory.manage"]["change"],
  signal: AbortSignal,
) {
  const { scope, ownerId } = owner;
  const repo = new MemoriesRepo(db, (s) => redactor.redact(s), owner);
  const metadata = new MemoryManagementRepo(db);
  const result = write(db, () => {
    signal.throwIfAborted();
    if (change.action === "import") {
      const duplicate = repo.similar(actor, change.text);
      if (duplicate) return { status: "duplicate" as const, memory: duplicate };
    }
    if (change.action === "undo") {
      const proposal = repo.proposal(change.proposalId);
      const undo = new MemoryUndoRepo(db);
      const snapshot = proposal && undo.get(proposal.botId, proposal.id);
      if (
        !proposal ||
        proposal.scope !== scope ||
        proposal.ownerId !== ownerId ||
        proposal.status !== "accepted" ||
        proposal.action !== "remove" ||
        !snapshot?.before ||
        snapshot.before.scope !== scope ||
        snapshot.before.ownerId !== ownerId ||
        proposal.memoryId !== snapshot.before.id ||
        snapshot.after !== null ||
        !sameMemoryRevision(repo.get(actor, snapshot.before.id) ?? null, null)
      )
        throw new RpcError(-32011, "memory_conflict");
      const restored = repo.restore(snapshot.before);
      repo.markUndone(proposal.id, restored.id);
      undo.remove(proposal.botId, proposal.id);
      new AuditRepo(db, redactor).append({
        botId: actor,
        kind: "memory.changed",
        summary: "Memory deletion undone / 已撤销记忆删除",
        detail: {
          actor: "user",
          memoryScope: scope,
          memoryOwnerId: ownerId,
          ...(scope === "group" ? { groupId: ownerId } : {}),
          reasonCode: "memory_user_undo",
          memoryId: restored.id,
        },
      });
      return { status: "updated" as const, memory: restored };
    }
    if (change.action === "update" || change.action === "remove" || change.action === "archive") {
      const prior = repo.get(actor, change.id);
      if (!prior) throw new RpcError(-32602, "memory_unavailable");
      if (!sameMemoryRevision(prior, change.expected))
        throw new RpcError(-32011, "memory_conflict");
    }
    const value =
      change.action === "import"
        ? repo.add(actor, change.text, null, change.category)
        : change.action === "update"
          ? repo.update(actor, change.id, { text: change.text, category: change.category })
          : change.action === "archive"
            ? repo.archive(actor, change.id, change.archived)
            : undefined;
    let undoProposalId: string | undefined;
    if (change.action === "remove") {
      const before = repo.get(actor, change.id);
      if (!before) throw new RpcError(-32602, "memory_unavailable");
      const proposal = repo.propose(
        actor,
        before.text,
        null,
        { action: "remove", memoryId: before.id },
        before.category,
      );
      repo.resolve(proposal.id, true);
      new MemoryUndoRepo(db).set(actor, proposal.id, before, null);
      undoProposalId = proposal.id;
    }
    if (change.action === "clear") {
      if (metadata.revision(owner) !== change.expectedRevision)
        throw new RpcError(-32011, "memory_conflict");
      repo.clear(actor);
      metadata.clearPending(owner);
      new MemoryUndoRepo(db).clearOwner(owner);
    }
    new AuditRepo(db, redactor).append({
      botId: owner.scope === "bot" ? owner.ownerId : actor,
      kind: "memory.changed",
      summary: "Memory managed by user / 用户管理记忆",
      detail: {
        actor: "user",
        memoryScope: scope,
        memoryOwnerId: ownerId,
        ...(scope === "group" ? { groupId: ownerId } : {}),
        reasonCode: `memory_user_${change.action}`,
        ...(value
          ? { memoryId: value.id }
          : change.action === "remove"
            ? { memoryId: change.id }
            : {}),
      },
    });
    return {
      status:
        change.action === "import"
          ? ("added" as const)
          : change.action === "update" || change.action === "archive"
            ? ("updated" as const)
            : change.action === "remove"
              ? ("removed" as const)
              : ("cleared" as const),
      ...(value ? { memory: value } : {}),
      ...(undoProposalId ? { undoProposalId } : {}),
    };
  });
  if (result.status !== "duplicate")
    memoryChanged(
      db,
      peer,
      owner.scope === "bot" ? owner.ownerId : actor,
      result.status === "added"
        ? "added"
        : result.status === "updated"
          ? "updated"
          : result.status === "removed"
            ? "removed"
            : "cleared",
      result.memory?.id ?? (change.action === "remove" ? change.id : undefined),
      undefined,
      owner,
    );
  return result;
}

function write<T>(db: DatabaseSync, action: () => T): T {
  try {
    return transaction(db, action);
  } catch (error) {
    if (error instanceof Error && error.message === "Memory quota exceeded")
      throw new RpcError(-32602, "memory_quota");
    if (error instanceof TypeError && error.message === "group_memory_unavailable")
      throw new RpcError(-32602, "group_memory_unavailable");
    throw error;
  }
}
