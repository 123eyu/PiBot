import { setImmediate } from "node:timers/promises";
import { routineSelectionFor, workplaceUnavailableReason } from "@pibot/brain/kit";
import type { MethodParams, MethodResults, Routine } from "@pibot/protocol";
import { isIndefinitePause, RpcError } from "@pibot/protocol";
import { nextCron } from "@pibot/scheduler";
import { BotsRepo } from "@pibot/storage";
import { RoutineDisplayRepo } from "../../store/index.ts";
import { safeErrorDetails } from "../safe-error.ts";
import { dateWindow } from "../schedule/date.ts";
import type { RoutineService } from "../service.ts";

function eligible(s: RoutineService, routine: Routine) {
  const bot = new BotsRepo(s.deps.db).get(routine.botId);
  return (
    routine.enabled &&
    !routine.authorizationError &&
    !routine.deletedAt &&
    !routine.pausedReason &&
    !!bot &&
    !bot.archivedAt
  );
}
function calculationBudget(signal: AbortSignal) {
  let calls = 0;
  const deadline = performance.now() + 15000;
  return async () => {
    signal.throwIfAborted();
    if (++calls > 50000 || performance.now() > deadline)
      throw new RpcError(-32000, "routine_calendar_budget");
    if (calls % 32 === 0) await setImmediate(undefined, { signal });
  };
}
// The page refreshes every 30 seconds; waiting for a transport timeout once per row would stall
// it, so one probe gets a short deadline. A timeout proves nothing about the target: a busy
// machine can push a local folder past it, and an offline target reports itself quickly
// (`runner_target_offline` / `transport_closed`), so a timeout shows no badge and the next
// refresh decides again.
const WORKSPACE_PROBE_TIMEOUT_MS = 3000;
type WorkspaceProbes = Map<string, Promise<WorkspaceNotice | undefined>>;
/**
 * What the row needs to explain a workplace that changed under a task.
 *
 * `kind` is only set when a folder cannot be resolved at all (the run fails); `references` covers
 * the folders a run now skips, which is a lighter state because the task still runs.
 */
interface WorkspaceNotice {
  kind?: "workspace" | "runner";
  /** Names (never paths) of the folders that no longer resolve, for the row's wording. */
  folders?: string[];
  /** Read-only reference / watched folders left out of the run because they are gone. */
  references?: string[];
}
/**
 * The task's own folder can be gone without any preauthorization record to carry the
 * notice. A reference folder the person deleted no longer fails the run, so the row has
 * to probe anyway — otherwise the task page stays silent about a folder it just skipped.
 *
 * Several tasks can share one Bot and workplace (and an offline target), so within one listing the
 * result is cached by that pair, mirroring the annotation cache.
 */
function taskWorkspaceUnavailable(
  s: RoutineService,
  routine: Routine,
  signal: AbortSignal,
  probes: WorkspaceProbes,
): Promise<WorkspaceNotice | undefined> {
  let selection: ReturnType<typeof routineSelectionFor>;
  try {
    signal.throwIfAborted();
    selection = routineSelectionFor(s.deps.local, {
      botId: routine.botId,
      workplace: routine.workplace,
      triggers: routine.triggers,
    });
  } catch (error) {
    signal.throwIfAborted();
    s.deps.local.deps.logger.warn(
      JSON.stringify({
        module: "routines",
        event: "routine_row_workspace_failed",
        routineId: routine.id,
        ...safeErrorDetails(error),
      }),
    );
    return Promise.resolve(undefined);
  }
  const key = [routine.botId, selection.selection.primary, ...selection.selection.readonly].join(
    "\0",
  );
  let probe = probes.get(key);
  if (!probe) {
    probe = (async () => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(WORKSPACE_PROBE_TIMEOUT_MS)]);
      try {
        const resolved = await s.deps.local.workplaces.context(routine.botId, deadline, selection);
        signal.throwIfAborted();
        const references = resolved.gone?.map((folder) => folder.name) ?? [];
        return references.length ? { references } : undefined;
      } catch (error) {
        signal.throwIfAborted();
        if (deadline.aborted) {
          // Only the deadline aborted here (the outer signal was rethrown above). No path is
          // logged; the event alone shows the listing is probing slower than the budget.
          s.deps.local.deps.logger.warn(
            JSON.stringify({ module: "routines", event: "routine_row_workspace_timeout" }),
          );
          return undefined;
        }
        const unavailable = workplaceUnavailableReason(error);
        // One task's folder must not fail the whole listing, but an unrecognized failure is still
        // a bug; log one redacted line so it does not disappear behind a missing badge.
        if (!unavailable) {
          s.deps.local.deps.logger.warn(
            JSON.stringify({
              module: "routines",
              event: "routine_row_workspace_failed",
              ...safeErrorDetails(error),
            }),
          );
          return undefined;
        }
        if (unavailable === "runner") return { kind: "runner" };
        // A deleted reference folder no longer fails the run, so the names come from the
        // same selection instead of from the error, and the row can say which one is gone.
        const folders = await s.deps.local.workplaces
          .goneFolders(routine.botId, selection, deadline)
          .catch(() => []);
        return { kind: "workspace", ...(folders.length ? { folders } : {}) };
      }
    })();
    probes.set(key, probe);
  }
  return probe;
}
async function nextAt(
  routine: Routine,
  after: number,
  step: () => Promise<void>,
  includeOverdue = false,
) {
  let next: number | null = null;
  for (const trigger of routine.triggers) {
    if (trigger.config.kind === "once") {
      const at = Date.parse(trigger.config.at);
      if (
        !trigger.state.consumedAt &&
        (at > after || includeOverdue) &&
        (next === null || at < next)
      )
        next = at;
      continue;
    }
    if (trigger.config.kind !== "cron") continue;
    await step();
    const watermark = Date.parse(trigger.state.lastScheduledAt ?? routine.lastScheduledAt ?? "");
    const at = nextCron(
      trigger.config.expr,
      trigger.config.timezone,
      Math.max(after, Number.isFinite(watermark) ? watermark : after),
    );
    if (next === null || at < next) next = at;
  }
  return next;
}

export async function routineRows(
  s: RoutineService,
  ids: string[],
): Promise<MethodResults["routines.rows"]> {
  const now = Date.now(),
    pausedUntil = s.settings.pausedUntil();
  const step = calculationBudget(s.signal()),
    signal = s.signal(),
    repo = new RoutineDisplayRepo(s.deps.db);
  const probes: WorkspaceProbes = new Map(),
    rows: MethodResults["routines.rows"]["rows"] = [];
  for (const id of ids) {
    await step();
    const routine = s.require(id);
    const workspaceUnavailable = await taskWorkspaceUnavailable(s, routine, signal, probes); // An indefinite pause has no "after the pause" point; asking cron past year 9999 would fail.
    const next =
      eligible(s, routine) && !isIndefinitePause(pausedUntil)
        ? await nextAt(routine, Math.max(now, Date.parse(pausedUntil ?? "") || now), step, true)
        : null;
    const state = repo.state(id);
    if (state.lastResult?.summary)
      state.lastResult.summary = s.deps.redactor.redact(state.lastResult.summary).slice(0, 2000);
    if (state.onceOutcome?.summary)
      state.onceOutcome.summary = s.deps.redactor.redact(state.onceOutcome.summary).slice(0, 2000);
    rows.push({
      routineId: id,
      nextAt: next === null ? null : new Date(next).toISOString(),
      ...state,
      ...(workspaceUnavailable?.kind ? { workspaceUnavailable: workspaceUnavailable.kind } : {}),
      ...(workspaceUnavailable?.folders?.length
        ? { workspaceMissing: workspaceUnavailable.folders }
        : {}),
      ...(workspaceUnavailable?.references?.length
        ? { workspaceReferenceMissing: workspaceUnavailable.references }
        : {}),
    });
  }
  return { at: new Date(now).toISOString(), pausedUntil, rows };
}

type Candidate = { routine: Routine; at: number };
function earlier(a: Candidate, b: Candidate) {
  return a.at < b.at || (a.at === b.at && a.routine.id < b.routine.id);
}
function calendarQueue() {
  const items: Candidate[] = [];
  return {
    push(item: Candidate) {
      items.push(item);
      let index = items.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        const above = items[parent];
        if (!above || !earlier(item, above)) break;
        items[index] = above;
        index = parent;
      }
      items[index] = item;
    },
    pop() {
      const first = items[0],
        last = items.pop();
      if (!first || !last || !items.length) return first;
      let index = 0;
      while (index * 2 + 1 < items.length) {
        let child = index * 2 + 1;
        const left = items[child],
          right = items[child + 1];
        if (left && right && earlier(right, left)) child++;
        const below = items[child];
        if (!below || !earlier(below, last)) break;
        items[index] = below;
        index = child;
      }
      items[index] = last;
      return first;
    },
  };
}

export async function plannedRoutines(
  s: RoutineService,
  query: MethodParams["routines.planned"],
): Promise<MethodResults["routines.planned"]> {
  const { from, to } = dateWindow(query.date, query.timezone),
    now = Date.now();
  const start = Math.max(
    Date.parse(from) - 1,
    now,
    Date.parse(s.settings.pausedUntil() ?? "") || now,
  );
  const cursor = query.cursor,
    end = Date.parse(to),
    limit = query.limit ?? 50;
  if (cursor && (cursor.at < from || cursor.at >= to))
    throw new RpcError(-32602, "Invalid calendar cursor");
  if (start >= end)
    return { from, to, asOf: new Date(now).toISOString(), points: [], nextCursor: null };
  const step = calculationBudget(s.signal()),
    queue = calendarQueue();
  let visited = 0;
  for (const routine of s.routines()) {
    await step();
    if (++visited > 10000) throw new RpcError(-32000, "routine_calendar_budget");
    if (!eligible(s, routine)) continue;
    const after = cursor
      ? Math.max(start, Date.parse(cursor.at) - (routine.id > cursor.routineId ? 1 : 0))
      : start;
    const at = await nextAt(routine, after, step);
    if (at !== null && at < end) queue.push({ routine, at });
  }
  const points: MethodResults["routines.planned"]["points"] = [];
  for (let item = queue.pop(); item; item = queue.pop()) {
    await step();
    if (points.length === limit) {
      const last = points.at(-1);
      return {
        from,
        to,
        asOf: new Date(now).toISOString(),
        points,
        nextCursor: last ? { at: last.at, routineId: last.routineId } : null,
      };
    }
    points.push({
      routineId: item.routine.id,
      botId: item.routine.botId,
      conversationId: item.routine.topicConversationId,
      at: new Date(item.at).toISOString(),
    });
    const next = await nextAt(item.routine, item.at, step);
    if (next !== null && next < end) queue.push({ routine: item.routine, at: next });
  }
  return { from, to, asOf: new Date(now).toISOString(), points, nextCursor: null };
}
