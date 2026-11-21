import { type AuditFilter, type AuditRange, auditCutoff } from "@pibot/client-core";
import type { AuditEntry, MethodParams } from "@pibot/protocol";
import { type Peer, useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTimelineDay } from "../chat/messages/MessageTime.tsx";
import { type ActivityEntry, mergeActivity, runActivity } from "./activity.ts";
import { ActivityPager } from "./activity-pager.ts";
import { RoutineHistoryPager, rereadRoutineHistory } from "./history-pager.ts";
import { AuditPager } from "./pager.ts";
import { AuditRefreshPager } from "./refresh-pager.ts";

type Request = {
  context: { peer: Peer | null; scope: string };
  pager: AuditRefreshPager<ActivityEntry>;
  refreshRuns(entries: ActivityEntry[], signal: AbortSignal): Promise<ActivityEntry[]>;
  lifetime: AbortController;
  locked: boolean;
  pendingRefresh: boolean;
  entries: ActivityEntry[];
  sources: Map<string, AuditEntry>;
};
export function useActivityRecords(
  botId: string,
  filter: AuditFilter,
  range: AuditRange,
  showInternal = false,
  visibleLimit = 50,
  withRuns = true,
  groupId?: string,
  enabled = true,
) {
  const { peer } = useRpc();
  const day = useTimelineDay();
  const scope = JSON.stringify([
    botId,
    groupId,
    filter,
    range,
    showInternal,
    visibleLimit,
    withRuns,
    day,
    enabled,
  ]);
  const [state, setState] = useState({
    context: { peer, scope },
    entries: [] as ActivityEntry[],
    loading: true,
    error: false,
    more: false,
    sources: new Map<string, AuditEntry>(),
  });
  const current = useRef<Request | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const read = useCallback(async function readPage(fresh = false) {
    const request = current.current;
    if (!request) return;
    if (request.locked) {
      if (fresh) request.pendingRefresh = true;
      return;
    }
    request.locked = true;
    setState((state) => ({ ...state, loading: true, error: false }));
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), 30_000);
    try {
      const pager = request.pager;
      const signal = AbortSignal.any([request.lifetime.signal, deadline.signal]);
      const updates = fresh ? await request.refreshRuns(request.entries, signal) : [];
      const page = await pager.next(signal, request.entries[0], fresh);
      if (current.current !== request || request.lifetime.signal.aborted) return;
      request.entries = mergeActivity(request.entries, [...updates, ...page]);
      for (const [key, entry] of pager.sources) request.sources.set(key, entry);
      while (request.sources.size > 1000) {
        const key = request.sources.keys().next().value;
        if (key) request.sources.delete(key);
      }
      setState({
        context: request.context,
        entries: [...request.entries],
        loading: false,
        error: false,
        more: request.pager.more,
        sources: new Map(request.sources),
      });
    } catch {
      if (current.current === request && !request.lifetime.signal.aborted) {
        setState((state) => ({ ...state, loading: false, error: true, more: request.pager.more }));
      }
    } finally {
      clearTimeout(timeout);
      request.locked = false;
      if (
        current.current === request &&
        !request.lifetime.signal.aborted &&
        request.pendingRefresh
      ) {
        request.pendingRefresh = false;
        void readPage(true);
      }
    }
  }, []);
  const load = useCallback(() => read(), [read]);
  const refresh = useCallback(() => read(true), [read]);
  const changed = useCallback(() => {
    if (!timer.current)
      timer.current = setTimeout(() => {
        timer.current = undefined;
        void refresh();
      }, 250);
  }, [refresh]);
  useRpcEvent("approval.requested", changed);
  useRpcEvent("approval.resolved", changed);
  useRpcEvent("providers.loginState", changed);
  useRpcEvent("routines.changed", changed);
  useRpcEvent("routine.run", (event) => {
    if (!botId || event.botId === botId) changed();
  });
  useRpcEvent("chat.tool", (event) => {
    if ((!botId || event.botId === botId) && event.phase === "end") changed();
  });
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Local midnight resets the calendar range and day groups.
  useEffect(() => {
    if (!enabled) {
      setState({
        context: { peer, scope },
        entries: [],
        loading: false,
        error: false,
        more: false,
        sources: new Map(),
      });
      return;
    }
    const cutoff = auditCutoff(range);
    const fetchHistory = (params: MethodParams["routines.history"]) =>
      peer ? peer.call("routines.history", params) : Promise.reject(new Error("Disconnected"));
    const includeRuns = withRuns && (filter === "all" || filter === "scheduling");
    const create = () =>
      new ActivityPager(
        new AuditPager(
          (params) =>
            peer
              ? peer.call("audit.list", { ...params, ...(groupId ? { groupId } : {}) })
              : Promise.reject(new Error("Disconnected")),
          filter,
          botId || undefined,
          cutoff,
          showInternal,
          visibleLimit,
        ),
        includeRuns ? new RoutineHistoryPager(fetchHistory, botId || undefined, cutoff) : undefined,
        visibleLimit,
      );
    const request: Request = {
      context: { peer, scope },
      pager: new AuditRefreshPager(create),
      refreshRuns: async (entries, signal) =>
        (
          await rereadRoutineHistory(
            fetchHistory,
            entries.filter((entry) => entry.type === "routine-run").map((entry) => entry.run.id),
            signal,
            botId || undefined,
            cutoff,
          )
        ).map(runActivity),
      lifetime: new AbortController(),
      locked: false,
      pendingRefresh: false,
      entries: [],
      sources: new Map(),
    };
    current.current = request;
    setState({
      context: request.context,
      entries: [],
      loading: true,
      error: false,
      more: false,
      sources: new Map(),
    });
    void load();
    return () => {
      request.lifetime.abort();
      clearTimeout(timer.current);
      timer.current = undefined;
      if (current.current === request) current.current = undefined;
    };
  }, [
    peer,
    botId,
    groupId,
    filter,
    range,
    showInternal,
    visibleLimit,
    withRuns,
    day,
    scope,
    load,
    enabled,
  ]);
  // Effects run after render; never paint the preceding peer/filter's records during that gap.
  const visible =
    state.context.peer === peer && state.context.scope === scope
      ? state
      : {
          ...state,
          entries: [] as ActivityEntry[],
          sources: new Map<string, AuditEntry>(),
          loading: true,
          error: false,
          more: false,
        };
  return {
    entries: visible.entries,
    loading: visible.loading,
    error: visible.error,
    more: visible.more,
    sources: visible.sources,
    load,
    refresh,
    day,
  };
}

// ProfileActivity keeps its existing audit-only contract; the main log opts into typed runs.
export function useAuditRecords(
  botId: string,
  filter: AuditFilter,
  range: AuditRange,
  showInternal = false,
  visibleLimit = 50,
) {
  const records = useActivityRecords(botId, filter, range, showInternal, visibleLimit, false);
  return {
    ...records,
    entries: records.entries.flatMap((entry) => (entry.type === "audit" ? [entry.entry] : [])),
  };
}
