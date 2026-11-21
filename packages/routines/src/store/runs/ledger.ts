import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@pibot/protocol";
import { transaction } from "@pibot/storage";

export type LedgerKind = "context" | "input" | "output" | "send";
export interface LedgerRow {
  routineRunId: string;
  occurrenceId: string;
  kind: LedgerKind;
  key: string;
  facts: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
// One run's ledger stays small: the brain caps inputs, outputs and sends before writing them.
const perRunLimit = 1000;
const columns =
  "routine_run_id AS routineRunId,occurrence_id AS occurrenceId,kind,item_key AS key,facts,created_at AS createdAt,updated_at AS updatedAt";
function parse(row: Record<string, unknown>): LedgerRow {
  return {
    routineRunId: String(row.routineRunId),
    occurrenceId: String(row.occurrenceId),
    kind: String(row.kind) as LedgerKind,
    key: String(row.key),
    facts: JSON.parse(String(row.facts)) as Record<string, unknown>,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

/** The run ledger table. Facts are validated by the brain before they get here. */
export class RoutineRunLedgerRepo {
  constructor(private readonly db: DatabaseSync) {}
  /** Insert or replace one item; the first time it was recorded is kept. */
  put(routineRunId: string, occurrenceId: string, kind: LedgerKind, key: string, facts: object) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO routine_run_ledger(routine_run_id,occurrence_id,kind,item_key,facts,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(routine_run_id,kind,item_key) DO UPDATE SET facts=excluded.facts,updated_at=excluded.updated_at",
      )
      .run(
        IdSchema.parse(routineRunId),
        IdSchema.parse(occurrenceId),
        kind,
        key,
        JSON.stringify(facts),
        now,
        now,
      );
  }
  /** Several items in one transaction, so a crash never leaves half of a manifest. */
  putAll(
    routineRunId: string,
    occurrenceId: string,
    items: { kind: LedgerKind; key: string; facts: object }[],
  ) {
    transaction(this.db, () => {
      for (const item of items)
        this.put(routineRunId, occurrenceId, item.kind, item.key, item.facts);
    });
  }
  get(routineRunId: string, kind: LedgerKind, key: string) {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM routine_run_ledger WHERE routine_run_id=? AND kind=? AND item_key=?`,
      )
      .get(IdSchema.parse(routineRunId), kind, key);
    return row ? parse(row) : undefined;
  }
  list(routineRunId: string, kind?: LedgerKind) {
    return this.db
      .prepare(
        `SELECT ${columns} FROM routine_run_ledger WHERE routine_run_id=? AND (? IS NULL OR kind=?) ORDER BY created_at,item_key LIMIT ?`,
      )
      .all(IdSchema.parse(routineRunId), kind ?? null, kind ?? null, perRunLimit)
      .map(parse);
  }
  /** The same item in other attempts of one occurrence (the idempotency lookup for sends). */
  inOccurrence(occurrenceId: string, kind: LedgerKind, key: string, exceptRunId: string) {
    return this.db
      .prepare(
        `SELECT ${columns} FROM routine_run_ledger WHERE occurrence_id=? AND kind=? AND item_key=? AND routine_run_id<>? ORDER BY created_at LIMIT 50`,
      )
      .all(IdSchema.parse(occurrenceId), kind, key, IdSchema.parse(exceptRunId))
      .map(parse);
  }
}
