import { MemoryUndoRepo } from "../../../../packages/storage/src/bots/memory-undo.ts";
import type { Runtime } from "./runtime.ts";

/** Diagnose receipt visibility using identity/count only, never snapshot content. */
export function receiptSummary(r: Runtime, proposalIds: readonly string[]) {
  const undo = new MemoryUndoRepo(r.db);
  let accepted = 0;
  let snapshots = 0;
  let creatorMismatch = 0;
  for (const id of proposalIds) {
    const proposal = r.db
      .prepare("SELECT bot_id AS botId,status FROM scoped_memory_proposals WHERE id=?")
      .get(id);
    if (proposal?.status === "accepted") accepted++;
    if (!proposal) continue;
    const snapshot = undo.get(String(proposal.botId), id);
    if (!snapshot) continue;
    snapshots++;
    if (
      [snapshot.before, snapshot.after].some(
        (image) => image && image.scope !== "user" && image.botId !== proposal.botId,
      )
    )
      creatorMismatch++;
  }
  return `accepted_${accepted}_snapshots_${snapshots}_creator_mismatch_${creatorMismatch}`;
}
