import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  IdSchema,
  type Page,
  RoutineTriggerSchema,
  type RoutineTriggerState,
  RoutineTriggerStateSchema,
  RoutineTriggersInputSchema,
} from "@pibot/protocol";
import { readPage, transaction } from "@pibot/storage";

const identity = (config: import("@pibot/protocol").RoutineTrigger["config"]) =>
  config.kind === "once" ? `once:${config.at}` : JSON.stringify(config);
const columns = "id,routine_id AS routineId,config,state,created_at AS createdAt";
function parse(row: Record<string, unknown>) {
  return RoutineTriggerSchema.parse({
    ...row,
    config: JSON.parse(String(row.config)),
    state: JSON.parse(String(row.state)),
  });
}
export class RoutineTriggersRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string) {
    const row = this.db
      .prepare(`SELECT ${columns} FROM routine_triggers WHERE id=?`)
      .get(IdSchema.parse(id));
    return row ? parse(row) : undefined;
  }
  list(routineId: string, page: Page = {}) {
    return readPage(
      this.db,
      "routine_triggers",
      columns,
      "created_at",
      page,
      [
        ["routine_id", IdSchema.parse(routineId)],
        ["deleted_at", null],
      ],
      [["routine_id", routineId]],
    ).map(parse);
  }
  /** Live triggers of several routines in one indexed query (at most 32 each, by schema). */
  forRoutines(routineIds: readonly string[]) {
    const byRoutine = new Map<string, ReturnType<typeof parse>[]>();
    if (!routineIds.length) return byRoutine;
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM routine_triggers WHERE routine_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL ORDER BY created_at DESC,id DESC`,
      )
      .all(JSON.stringify(routineIds.map((id) => IdSchema.parse(id))));
    for (const row of rows) {
      const trigger = parse(row);
      const list = byRoutine.get(String(row.routineId)) ?? [];
      list.push(trigger);
      byRoutine.set(String(row.routineId), list);
    }
    return byRoutine;
  }
  replace(routineId: string, inputs: unknown[]) {
    const configs = RoutineTriggersInputSchema.parse(inputs);
    if (!configs.length || configs.length > 32) throw new TypeError("Invalid trigger count");
    return transaction(this.db, () => {
      const now = new Date().toISOString();
      if (
        !this.db.prepare("SELECT 1 FROM routines WHERE id=? AND deleted_at IS NULL").get(routineId)
      )
        throw new TypeError("Unknown routine");
      const previous = this.list(routineId, { limit: 32 });
      const matches = new Map<string, { entries: typeof previous; next: number }>();
      for (const trigger of previous) {
        const key = identity(trigger.config);
        const bucket = matches.get(key) ?? { entries: [], next: 0 };
        bucket.entries.push(trigger);
        matches.set(key, bucket);
      }
      const retained = new Set<string>();
      const insert = this.db.prepare(
        "INSERT INTO routine_triggers(id,routine_id,kind,config,cooldown_min,state,created_at) VALUES (?,?,?,?,?,'{}',?)",
      );
      for (const config of configs) {
        const bucket = matches.get(identity(config));
        const existing = bucket?.entries[bucket.next++];
        if (existing) {
          // A full confirmation can change only the name; keep unedited snapshots and watermarks.
          retained.add(existing.id);
          this.db
            .prepare("UPDATE routine_triggers SET config=? WHERE id=? AND deleted_at IS NULL")
            .run(JSON.stringify(config), existing.id);
          continue;
        }
        insert.run(
          randomUUID(),
          routineId,
          config.kind,
          JSON.stringify(config),
          config.kind === "folder" ? config.cooldownMin : 5,
          now,
        );
      }
      const retire = this.db.prepare(
        "UPDATE routine_triggers SET deleted_at=? WHERE id=? AND routine_id=? AND deleted_at IS NULL",
      );
      for (const trigger of previous)
        if (!retained.has(trigger.id)) retire.run(now, trigger.id, routineId);
      return this.list(routineId, { limit: 32 });
    });
  }
  consumeOnce(id: string, expected: RoutineTriggerState, at: string) {
    const trigger = this.get(id);
    if (trigger?.config.kind !== "once" || expected.consumedAt) return false;
    return this.checkpoint(id, expected, { ...expected, consumedAt: at });
  }
  checkpoint(id: string, expected: RoutineTriggerState, next: RoutineTriggerState) {
    const oldState = RoutineTriggerStateSchema.parse(expected),
      state = RoutineTriggerStateSchema.parse(next);
    if (oldState.consumedAt && state.consumedAt !== oldState.consumedAt)
      throw new TypeError("Once consumption is immutable");
    // CAS makes snapshot/watermark + run enqueue atomic inside the caller's outer transaction.
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT state FROM routine_triggers WHERE id=? AND deleted_at IS NULL")
        .get(IdSchema.parse(id));
      if (
        !row ||
        JSON.stringify(RoutineTriggerStateSchema.parse(JSON.parse(String(row.state)))) !==
          JSON.stringify(oldState)
      )
        return false;
      return (
        this.db
          .prepare(
            "UPDATE routine_triggers SET state=? WHERE id=? AND state=? AND deleted_at IS NULL",
          )
          .run(JSON.stringify(state), id, String(row.state)).changes > 0
      );
    });
  }
}
