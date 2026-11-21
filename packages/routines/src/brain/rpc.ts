import type { RegisterRpc } from "@pibot/brain/kit";
import { abortable } from "@pibot/brain/kit";
import { RpcError, toRoutineRunView } from "@pibot/protocol";
import { resolveOnceTime } from "@pibot/scheduler";
import { PowerEventsRepo, transaction } from "@pibot/storage";
import { RoutinePreauthRepo } from "../store/index.ts";
import { dateWindow } from "./schedule/date.ts";
import type { RoutineService } from "./service.ts";
import { calendarList, triggerSources } from "./triggers/trigger-sources.ts";
import { validateRoutineTriggers } from "./validation/validation.ts";
import { plannedRoutines, routineRows } from "./views/display.ts";
import { routineHistory } from "./views/history.ts";

export function registerRoutineRpc(handle: RegisterRpc, s: RoutineService) {
  handle("routines.validateCron", async (input, { signal }) => {
    let issue: import("@pibot/protocol").MethodResults["routines.validateCron"]["issue"] = null;
    try {
      await validateRoutineTriggers(
        s.deps.local,
        [{ kind: "cron", ...input }],
        s.timing.cronMinIntervalMs,
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      const codes = [
        "syntax",
        "minute",
        "hour",
        "day",
        "month",
        "weekday",
        "minimum",
        "timezone",
      ] as const;
      const known =
        error instanceof RpcError
          ? codes.find((value) => error.message === `routine_cron_${value}`)
          : undefined;
      if (!known) throw error;
      issue = known;
    }
    return { issue, minimumMinutes: s.timing.cronMinIntervalMs / 60000 };
  });
  handle("routines.resolveOnceTime", async (input) => resolveOnceTime(input, s.signal()));
  const mutate = <T>(action: () => Promise<T>) => s.queue.submit(action);
  handle("routines.pickFolder", async () => {
    if (!s.deps.host.pickFolder) throw new RpcError(-32603, "Folder picker unavailable");
    const signal = AbortSignal.any([s.lifetime.signal, AbortSignal.timeout(630000)]);
    return abortable(s.deps.host.pickFolder(signal), signal);
  });
  handle("routines.triggerSources", async ({ botId }) => triggerSources(s.deps.local, botId));
  handle("routines.calendarList", (input, { signal }) =>
    calendarList(s.deps.local, input, AbortSignal.any([signal, s.lifetime.signal])),
  );
  handle("routines.rows", ({ ids }) => mutate(() => routineRows(s, ids)));
  handle("routines.planned", (query) => mutate(() => plannedRoutines(s, query)));
  handle("routines.summary", () => s.host.summary());
  handle("routines.list", async (query, { signal }) =>
    s.authorization.annotatePage(s.repo.list(query), signal),
  );
  handle("routines.get", async ({ id }, { signal }) =>
    s.authorization.annotate(s.repo.get(id) ?? s.require(id), signal),
  );
  handle("routines.create", ({ trialRunId, ...draft }) =>
    mutate(() => s.create(draft, trialRunId)),
  );
  handle("routines.update", ({ id, patch, expectedVersion }) =>
    mutate(() => s.update(id, patch, expectedVersion)),
  );
  handle("routines.delete", ({ id }) =>
    mutate(async () => {
      await s.remove(id);
      return { ok: true as const };
    }),
  );
  handle("routines.setEnabled", ({ id, enabled }) => mutate(() => s.setEnabled(id, enabled)));
  handle("routines.runNow", ({ id }) => mutate(() => s.runNow(id)));
  handle("routines.trialRun", (draft) => mutate(() => s.trial(draft)));
  handle("routines.resumeRun", ({ id }) => mutate(() => s.resumeRun(id)));
  handle("routines.runLedger", async ({ id }) => {
    if (!s.runs.get(id)) throw new RpcError(-32602, "Unknown routine run");
    return s.execution.ledger.view(id);
  });
  handle("routines.trialResult", async ({ runId }) => {
    const r = s.runs.require(runId);
    if (r.reason !== "trial") throw new RpcError(-32602, "Not a trial run");
    return toRoutineRunView(r);
  });
  handle("routines.runs", async ({ id, ...page }) => {
    s.require(id);
    return s.runs.list(id, page).map(toRoutineRunView);
  });
  handle("routines.history", async (query) => routineHistory(s, query));
  handle("routines.history.count", async (query) => s.runs.historyCount(query));
  handle("routines.settings.get", async () => s.settings.get());
  handle("routines.settings.set", (patch) =>
    mutate(async () => {
      const result = s.settings.set(patch);
      s.changed();
      return result;
    }),
  );
  handle("routines.proposals", async (query) => {
    if (!s.proposals) throw new RpcError(-32019, "routine_proposal_unavailable");
    return s.proposals.list(query);
  });
  handle("routines.proposal.resolve", (params) =>
    mutate(async () => {
      if (!s.proposals) throw new RpcError(-32019, "routine_proposal_unavailable");
      return s.proposals.resolve(params);
    }),
  );
  handle("routines.preauth.list", async ({ routineId, botId, ...page }) =>
    s.authorization.annotations(
      new RoutinePreauthRepo(s.deps.db).list({ routineId, botId }, page),
      botId,
    ),
  );
  handle("routines.preauth.revoke", ({ id }) =>
    mutate(async () => {
      const repo = new RoutinePreauthRepo(s.deps.db),
        value = repo.get(id);
      if (!value) throw new RpcError(-32602, "Unknown routine preauthorization");
      transaction(s.deps.db, () => {
        if (repo.revoke(id))
          s.audit("routine.preauth.revoked", s.repo.require(value.routineId), { preauthId: id });
      });
      s.changed();
      return { ok: true as const };
    }),
  );
  handle("routines.pauseAll", ({ until }) =>
    mutate(async () => {
      s.setPausedUntil(until);
      s.changed();
      await s.syncWatchers();
      return { ok: true as const };
    }),
  );
  handle("routines.resumeAll", () =>
    mutate(async () => {
      await s.resumeAll();
      await s.tick();
      return { ok: true as const };
    }),
  );
  handle("routines.resumeAway", ({ ids }) =>
    mutate(async () => {
      await s.resumeAway(ids);
      return { ok: true as const };
    }),
  );
  handle("routines.missed.resolve", ({ runId, action, missedPolicy }) =>
    mutate(async () => {
      const current = s.runs.get(runId);
      if (!current) throw new RpcError(-32602, "Unknown missed run");
      if (
        action === "catchup" &&
        Date.now() - Date.parse(current.scheduledFor) > s.timing.missedMaxAgeMs
      )
        throw new RpcError(-32602, "Missed run too old");
      const result = transaction(s.deps.db, () => {
        const resolved = s.runs.resolveMissed(runId, action, s.timing);
        if (!resolved) throw new RpcError(-32602, "Not a missed run");
        if (missedPolicy) s.settings.set({ missedPolicy });
        return resolved;
      });
      s.changedRun(result);
      if (result.status === "scheduled")
        await s.publish(result, result.routineId ? s.repo.get(result.routineId) : undefined);
      return toRoutineRunView(s.runs.require(result.id));
    }),
  );
  handle("routines.timeline", async ({ date, timezone, source, ...page }) => {
    const { from, to } = dateWindow(date, timezone);
    return source === "power"
      ? {
          source,
          events: new PowerEventsRepo(s.deps.db).list(from, to, page),
          context: new PowerEventsRepo(s.deps.db).contextBefore(from),
        }
      : { source, runs: s.runs.timeline(from, to, page).map(toRoutineRunView) };
  });
}
