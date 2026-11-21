import assert from "node:assert/strict";
import type { Routine, RoutineDraftInput } from "../../../packages/protocol/src/index.ts";
import { transaction } from "../../../packages/storage/src/index.ts";
import { until } from "../chat/harness.ts";
import type { M3Fixture } from "./fixture.ts";
export type Exercise = (name: string, action: (f: M3Fixture) => Promise<void>) => Promise<void>;

export function draft(f: M3Fixture, patch: Partial<RoutineDraftInput> = {}): RoutineDraftInput {
  return {
    botId: f.bot.id,
    name: "隔离任务",
    instructions: "只处理合成资料",
    triggers: [{ kind: "cron", expr: "30 8 * * *", timezone: "Asia/Shanghai" }],
    ...patch,
  };
}
export function watermark(f: M3Fixture, routine: Routine, at: string) {
  transaction(f.db, () => {
    const latest = f.service.require(routine.id);
    for (const t of latest.triggers)
      if (t.config.kind === "cron")
        assert(f.service.triggers.checkpoint(t.id, t.state, { ...t.state, lastScheduledAt: at }));
    f.service.repo.watermark(routine.id, at);
  });
}
export async function terminal(f: M3Fixture, id: string) {
  return until(
    "例行真实终态",
    async () => f.service.runs.require(id),
    (r) => ["done", "failed", "cancelled", "timeout"].includes(r.status),
  );
}
export async function approval(f: M3Fixture) {
  const [card] = await until(
    "实际工具审批",
    () => f.rpc.call("approvals.pending", {}),
    (rows) => rows.length > 0,
  );
  assert(card);
  return card;
}
