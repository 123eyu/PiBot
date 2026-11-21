import type { DatabaseSync } from "node:sqlite";
import type { BrainRedactor } from "@pibot/brain/kit";
import { MemoriesRepo, type MemoryUndoRepo, sameMemoryRevision } from "@pibot/storage";
export function undoableMemory(
  db: DatabaseSync,
  botId: string,
  repo: MemoriesRepo,
  undo: MemoryUndoRepo,
  redactor: BrainRedactor,
  proposalIds?: readonly string[],
) {
  // A persisted before/after image is required, including for accepted background proposals.
  const snapshots = proposalIds
    ? proposalIds.flatMap((proposalId) => {
        const value = undo.get(botId, proposalId);
        return value ? [{ proposalId, ...value }] : [];
      })
    : undo.list(botId);
  return snapshots.flatMap((snapshot) => {
    const proposal = repo.proposal(snapshot.proposalId);
    if (!proposal || proposal.botId !== botId || proposal.status !== "accepted") return [];
    const owner = { scope: proposal.scope ?? "bot", ownerId: proposal.ownerId ?? botId };
    const targetId = snapshot.after?.id ?? snapshot.before?.id;
    // Creator attribution may differ after a user imports into another Bot's scope.
    // Both images must belong to the proposal's owner, including deleted targets.
    if (
      !targetId ||
      [snapshot.before, snapshot.after].some(
        (image) =>
          image !== null &&
          ((image.scope ?? "bot") !== owner.scope ||
            (image.ownerId ?? image.botId) !== owner.ownerId),
      )
    )
      return [];
    if (
      proposal.action === "add"
        ? snapshot.before !== null || proposal.resolvedMemoryId !== snapshot.after?.id
        : proposal.memoryId !== targetId ||
          (proposal.action === "remove"
            ? snapshot.after !== null
            : snapshot.before?.id !== snapshot.after?.id)
    )
      return [];
    const scoped = new MemoriesRepo(db, (text) => redactor.redact(text), owner);
    const current = scoped.get(botId, targetId) ?? null;
    if (!sameMemoryRevision(current, snapshot.after)) return [];
    return [{ ...proposal, text: redactor.redact(proposal.text) }];
  });
}
