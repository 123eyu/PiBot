import type { DatabaseSync } from "node:sqlite";
import { ContinuationIntentsRepo, ContinuationLedgersRepo, transaction } from "@pibot/storage";

/**
 * Phase 3: the durable side of automatic continuations. The in-memory services stay the
 * fast path for this process; everything a restart must know is written here in the same
 * transaction as the run/audit rows it describes.
 */
export class ContinuationState {
  readonly ledgers: ContinuationLedgersRepo;
  readonly intents: ContinuationIntentsRepo;
  /** Roots this process itself observed; rows from an earlier process wait for confirmation. */
  private readonly ownedRoots = new Set<string>();
  constructor(private readonly db: DatabaseSync) {
    this.ledgers = new ContinuationLedgersRepo(db);
    this.intents = new ContinuationIntentsRepo(db);
  }

  owned(rootRunId: string) {
    this.ownedRoots.add(rootRunId);
  }
  owns(rootRunId: string): boolean {
    return this.ownedRoots.has(rootRunId);
  }

  /**
   * The chain is over for good: no restore candidate and no remaining budget. Callers use this for
   * an explicit stop or a final release, never for a cache drop.
   */
  release(rootRunId: string) {
    transaction(this.db, () => {
      this.intents.release(rootRunId);
      this.ledgers.release(rootRunId);
    });
  }
}
