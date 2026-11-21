import type { DatabaseSync } from "node:sqlite";
import { type ExecutionCheckpoint, ExecutionCheckpointSchema } from "@pibot/protocol-base";

export class CheckpointRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(runId: string): ExecutionCheckpoint | undefined {
    const row = this.db
      .prepare("SELECT checkpoint_json FROM execution_checkpoints WHERE run_id=?")
      .get(runId);
    return row
      ? ExecutionCheckpointSchema.parse(JSON.parse(String(row.checkpoint_json)))
      : undefined;
  }
  set(input: Omit<ExecutionCheckpoint, "updatedAt">) {
    const value = ExecutionCheckpointSchema.parse({
      ...input,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare(`INSERT INTO execution_checkpoints(run_id,checkpoint_json) VALUES(?,?)
      ON CONFLICT(run_id) DO UPDATE SET checkpoint_json=excluded.checkpoint_json`)
      .run(value.runId, JSON.stringify(value));
    return value;
  }
  recover() {
    for (const row of this.db
      .prepare(
        "SELECT run_id,checkpoint_json FROM execution_checkpoints WHERE json_extract(checkpoint_json,'$.phase')='dispatch'",
      )
      .iterate()) {
      const old = ExecutionCheckpointSchema.parse(JSON.parse(String(row.checkpoint_json)));
      if (old.phase === "dispatch") this.set({ ...old, phase: "interrupted", outcome: "unknown" });
    }
  }
}
