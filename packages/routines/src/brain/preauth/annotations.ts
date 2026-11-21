import type { LocalService, PreparedTool } from "@pibot/brain/kit";
import {
  connectorPreauthIssue,
  routineSelectionFor,
  workplaceUnavailableReason,
} from "@pibot/brain/kit";
import { preauthInvalidReason } from "@pibot/policy";
import { type RoutinePreauth, RpcError } from "@pibot/protocol";
import { BotsRepo } from "@pibot/storage";
import { RoutinesRepo } from "../../store/index.ts";
import { safeErrorDetails } from "../safe-error.ts";
import { paidImageMatchesBot } from "../validation/validation.ts";

async function annotateRoutineGroup(
  local: LocalService,
  records: RoutinePreauth[],
  outer: AbortSignal,
  botId?: string,
  routineBots?: ReadonlyMap<string, string>,
) {
  outer.throwIfAborted();
  const budget = new AbortController();
  const timer = setTimeout(
    () => budget.abort(new DOMException("Routine validation deadline", "TimeoutError")),
    3000,
  );
  const signal = AbortSignal.any([outer, budget.signal]);
  const byBot = new Map<
    string,
    Promise<{
      settings: PreparedTool["settings"];
      boundary: NonNullable<PreparedTool["boundary"]> | undefined;
      isolated: boolean;
      /** Set only when the boundary could not be resolved at all (display invalidation). */
      unavailable?: "workspace" | "runner";
    }>
  >();
  outer.throwIfAborted();
  const results: RoutinePreauth[] = [];
  try {
    for (const record of records) {
      outer.throwIfAborted();
      let stage = "routine_lookup";
      try {
        signal.throwIfAborted();
        const routine = new RoutinesRepo(local.deps.db).get(record.routineId);
        const id = botId ?? routineBots?.get(record.routineId) ?? routine?.botId;
        if (!id) throw new RpcError(-32602, "Routine unavailable");
        // Each routine is checked against its own folders, so the key is the routine too.
        const key = `${id}:${routine?.botId === id ? record.routineId : ""}`;
        let promise = byBot.get(key);
        if (promise) stage = "cached_context";
        if (!promise) {
          promise = (async () => {
            stage = "permissions";
            const settings = local.permissions.effective(id);
            let boundary: NonNullable<PreparedTool["boundary"]>;
            try {
              stage = "workspace";
              boundary = (
                await local.workplaces.context(
                  id,
                  signal,
                  routine?.botId === id
                    ? routineSelectionFor(local, {
                        botId: id,
                        workplace: routine.workplace,
                        triggers: routine.triggers,
                      })
                    : undefined,
                )
              ).boundary;
            } catch (error) {
              signal.throwIfAborted();
              // Known workspace failures keep their actionable label. Unexpected adapter failures
              // reach the row-level validation notice and structural log below instead.
              // An offline execution target cannot be fixed by re-picking its folder.
              const unavailable = workplaceUnavailableReason(error);
              if (unavailable)
                return { settings, boundary: undefined, isolated: false, unavailable };
              throw error;
            }
            signal.throwIfAborted();
            stage = "isolation";
            const isolated = (await local.target.isolationStatus(signal)).available;
            return { settings, boundary, isolated };
          })();
          byBot.set(key, promise);
        }
        const { settings, boundary, isolated, unavailable } = await promise;
        stage = "connector";
        const connectorIssue =
          connectorPreauthIssue(local, id, record.operation) ??
          (record.operation.scope.kind === "paid_image" &&
          !paidImageMatchesBot(new BotsRepo(local.deps.db).get(id), record.operation.scope)
            ? "permission"
            : undefined);
        stage = "policy";
        const invalidReason = connectorIssue
          ? "permission"
          : boundary
            ? preauthInvalidReason(
                record,
                settings,
                boundary,
                boundary.location?.platform ?? local.deps.platform,
                isolated,
              )
            : (unavailable ?? "workspace");
        results.push({ ...record, ...(invalidReason ? { invalidReason } : {}) });
      } catch (error) {
        // A cancelled RPC must not manufacture an invalidation result or keep scanning.
        outer.throwIfAborted();
        // Error messages can contain paths or secrets from an injected adapter; log only fixed
        // categories and trusted error codes.
        local.deps.logger.error(
          JSON.stringify({
            module: "routines",
            event: "preauth_annotate_failed",
            routineId: record.routineId,
            preauthId: record.id,
            reasonCode: "routine_preauth_reauthorization_required",
            stage: signal.aborted ? "deadline" : stage,
            ...safeErrorDetails(error),
          }),
        );
        results.push({ ...record, invalidReason: "validation" });
      }
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

// A slow task owns only its deadline. FIFO workers ensure every other task is actually checked;
// a 200-task page needs at most seven 3-second batches, without launching unbounded probes.
const ANNOTATION_CONCURRENCY = 32;
export async function annotateRoutinePreauth(
  local: LocalService,
  records: RoutinePreauth[],
  botId?: string,
  routineBots?: ReadonlyMap<string, string>,
  parentSignal?: AbortSignal,
) {
  const outer = parentSignal
    ? AbortSignal.any([local.shutdown.signal, parentSignal])
    : local.shutdown.signal;
  outer.throwIfAborted();
  const grouped = new Map<string, { records: RoutinePreauth[]; indexes: number[] }>();
  for (const [index, record] of records.entries()) {
    const group = grouped.get(record.routineId) ?? { records: [], indexes: [] };
    group.records.push(record);
    group.indexes.push(index);
    grouped.set(record.routineId, group);
  }
  const groups = [...grouped.values()];
  const results: RoutinePreauth[] = new Array(records.length);
  let next = 0;
  async function worker() {
    for (;;) {
      outer.throwIfAborted();
      const group = groups[next++];
      if (!group) return;
      const annotated = await annotateRoutineGroup(local, group.records, outer, botId, routineBots);
      for (const [index, record] of annotated.entries()) {
        const position = group.indexes[index];
        if (position !== undefined) results[position] = record;
      }
    }
  }
  // Calls own their cancellation/cleanup. Drain workers before returning, including on failure;
  // racing a deadline against an adapter would leave work running beyond the concurrency limit.
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(ANNOTATION_CONCURRENCY, groups.length) }, () => worker()),
  );
  outer.throwIfAborted();
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  return results;
}
