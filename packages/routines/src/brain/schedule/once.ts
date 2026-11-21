import type { Routine, RoutineDraft } from "@pibot/protocol";
import { RpcError } from "@pibot/protocol";
import { transaction } from "@pibot/storage";
import { RoutineSchedulerStateRepo } from "../../store/index.ts";
import type { RoutineService } from "../service.ts";

export function validateNewOnce(draft: RoutineDraft, old?: Routine) {
  const appointment = draft.triggers.find((t) => t.kind === "once");
  if (appointment?.kind !== "once") return;
  const same = old?.triggers.find(
    (t) => t.config.kind === "once" && t.config.at === appointment.at,
  );
  if (same) {
    if (draft.enabled && !old?.enabled && same.state.consumedAt)
      throw new RpcError(-32602, "routine_once_consumed");
    return;
  }
  if (Date.parse(appointment.at) <= Date.now()) throw new RpcError(-32602, "routine_once_future");
}

export async function scheduleOnce(
  s: RoutineService,
  snapshot: Routine,
  now: number,
  missed: boolean,
) {
  const trigger = snapshot.triggers.find((t) => t.config.kind === "once");
  if (
    trigger?.config.kind !== "once" ||
    trigger.state.consumedAt ||
    Date.parse(trigger.config.at) > now
  )
    return;
  const scheduledFor = trigger.config.at;
  const run = transaction(s.deps.db, () => {
    // Re-read under the write lock: async validation/cancellation and another process may have edited it.
    const current = s.scheduleCurrent(snapshot);
    const t = current?.triggers.find((t) => t.id === trigger.id);
    if (
      !current ||
      !t ||
      t.config.kind !== "once" ||
      t.config.at !== scheduledFor ||
      t.state.consumedAt
    )
      return;
    const late = missed && Date.parse(scheduledFor) < now;
    const policy = current.missedPolicy ?? s.settings.get().missedPolicy;
    const tooOld = late && now - Date.parse(scheduledFor) > s.timing.missedMaxAgeMs;
    const status = late
      ? tooOld || policy === "skip"
        ? "skipped_missed"
        : policy === "ask"
          ? "missed"
          : "scheduled"
      : "scheduled";
    if (!s.triggers.consumeOnce(t.id, t.state, new Date(now).toISOString())) return;
    const record = s.runs.enqueue(
      {
        routineId: current.id,
        botId: current.botId,
        triggerId: t.id,
        reason: late && policy === "catchup" && !tooOld ? "catchup" : "once",
        scheduledFor,
        dedupeKey: `once:${t.id}`,
        status,
      },
      s.timing.queueWaitMs,
    );
    // Even skip/ask preserve the original trigger fact and topic navigation in this transaction.
    s.execution.triggerMessages.ensure(record, current);
    if (tooOld) new RoutineSchedulerStateRepo(s.deps.db).markMissedTooOld(record.id);
    return s.runs.require(record.id);
  });
  if (run) s.changedRun(run);
  // Publication is handled by tick, including catchup's persisted one-minute grace.
}
