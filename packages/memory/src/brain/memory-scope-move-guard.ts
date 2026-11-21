import type { DatabaseSync } from "node:sqlite";
import { RpcError } from "@pibot/protocol-base";
import {
  scopeMoveCanUndo,
  scopeMoveDestinationUnchanged,
  scopeMoveHasLiveCopy,
} from "@pibot/storage";

/** Both checks run inside MemoryService's resolve transaction. */
export function assertScopeMoveRemoval(db: DatabaseSync, proposalId: string) {
  if (!scopeMoveHasLiveCopy(db, proposalId))
    throw new RpcError(-32011, "memory_move_copy_required");
}

export function assertScopeMoveUndo(db: DatabaseSync, proposalId: string) {
  if (!scopeMoveCanUndo(db, proposalId)) throw new RpcError(-32011, "memory_move_restore_required");
}

export function assertScopeMoveDestination(db: DatabaseSync, proposalId: string) {
  if (!scopeMoveDestinationUnchanged(db, proposalId)) throw new RpcError(-32011, "memory_conflict");
}
