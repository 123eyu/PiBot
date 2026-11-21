import type { ContinuationLedgersRepo } from "@pibot/storage";
import {
  CONTINUATION_ROOT_CAPACITY,
  NO_PROGRESS_LIMIT,
  ROOT_CONTINUATION_LIMIT,
} from "./continuation-limits.ts";

export type ContinuationKind = "todo" | "parent" | "summary";
export type ContinuationStop = "round_limit" | "no_progress";
export type TakeResult = { ok: true } | { ok: false; reason: ContinuationStop };

/** The counters a restart must keep: rounds used and the per-kind no-progress streaks. */
export interface Ledger {
  used: number;
  idle: Record<ContinuationKind, number>;
}

const empty = (): Ledger => ({ used: 0, idle: { todo: 0, parent: 0, summary: 0 } });

/**
 * Every automatic continuation of one root run draws on the same round budget, and each kind keeps
 * its own streak of rounds that changed nothing (Q2). The table is the source of truth: in-memory
 * state would hand a restarted chain a fresh budget, which is the opposite of a limit. Reads and
 * writes are one synchronous SQLite statement each, so callers can group them with their run row
 * in one transaction.
 *
 * Refusing a new root once the table is full is deliberate; evicting an old root would hand that
 * tree a fresh budget too.
 */
export class ContinuationBudget {
  constructor(
    private readonly ledgers: ContinuationLedgersRepo,
    private readonly warning: (root: string) => void,
  ) {}

  /** Whether this take would be accepted, without recording a round. */
  preview(root: string, kind: ContinuationKind, progressed: boolean): TakeResult {
    return this.evaluate(root, kind, progressed);
  }

  take(root: string, kind: ContinuationKind, progressed: boolean): TakeResult {
    const result = this.evaluate(root, kind, progressed);
    if (!result.ok) return result;
    this.save(root, progress(this.read(root) ?? empty(), kind, progressed));
    return result;
  }

  peek(root: string): Ledger | undefined {
    return this.read(root);
  }

  /** Snapshot before a take, so a rejected publish can restore the exact previous counters. */
  snapshot(root: string): Ledger | undefined {
    return this.read(root);
  }

  /** Undo one take without inventing progress: the row returns to the snapshot or disappears. */
  refund(root: string, previous: Ledger | undefined) {
    if (!previous) {
      this.ledgers.release(root);
      return;
    }
    this.save(root, previous);
  }

  release(root: string) {
    this.ledgers.release(root);
  }

  /** Cache-only clear on app pause/dispose: the persisted counters are the durable state. */
  clear() {}

  private evaluate(root: string, kind: ContinuationKind, progressed: boolean): TakeResult {
    const ledger = this.read(root);
    if (!ledger && this.ledgers.count() >= CONTINUATION_ROOT_CAPACITY) {
      // A silent refusal would look like a follow-through that simply never happened.
      this.warning(root);
      return { ok: false, reason: "round_limit" };
    }
    // No-progress wins over the total: the chain must stop at the same round it would have before.
    if (!progressed && (ledger?.idle[kind] ?? 0) + 1 >= NO_PROGRESS_LIMIT)
      return { ok: false, reason: "no_progress" };
    if ((ledger?.used ?? 0) >= ROOT_CONTINUATION_LIMIT) return { ok: false, reason: "round_limit" };
    return { ok: true };
  }

  private read(root: string): Ledger | undefined {
    const row = this.ledgers.get(root);
    if (!row) return undefined;
    return {
      used: row.used,
      idle: { todo: row.idleTodo, parent: row.idleParent, summary: row.idleSummary },
    };
  }

  private save(root: string, ledger: Ledger) {
    this.ledgers.save({
      rootRunId: root,
      used: ledger.used,
      idleTodo: ledger.idle.todo,
      idleParent: ledger.idle.parent,
      idleSummary: ledger.idle.summary,
    });
  }
}

function progress(ledger: Ledger, kind: ContinuationKind, progressed: boolean): Ledger {
  const idle = { ...ledger.idle };
  idle[kind] = progressed ? 0 : idle[kind] + 1;
  return { used: ledger.used + 1, idle };
}
