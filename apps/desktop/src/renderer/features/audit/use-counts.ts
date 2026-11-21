import { type AuditRange, auditCutoff } from "@pibot/client-core";
import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { activityTypeCounts } from "./type-filter.ts";

export function useActivityCounts(
  botId: string,
  groupId: string | undefined,
  range: AuditRange,
  showInternal: boolean,
  day: string,
) {
  const { peer } = useRpc();
  const scope = JSON.stringify([botId, groupId, range, showInternal, day]);
  const [state, setState] = useState<{
    peer: typeof peer;
    scope: string;
    counts?: ReturnType<typeof activityTypeCounts>;
    error: boolean;
  }>({ peer, scope, error: false });
  const [revision, setRevision] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A busy run emits events faster than a slow count query returns; restarting on every burst
  // would cancel each query before it lands, so events during a query queue one refresh after it.
  const busy = useRef(false);
  const pending = useRef(false);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const changed = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (busy.current) pending.current = true;
      else refresh();
    }, 250);
  }, [refresh]);
  useRpcEvent("approval.requested", changed);
  useRpcEvent("approval.resolved", changed);
  useRpcEvent("providers.loginState", changed);
  useRpcEvent("routines.changed", changed);
  useRpcEvent("routine.run", changed);
  useRpcEvent("chat.tool", (event) => {
    if (event.phase === "end") changed();
  });
  useRpcEvent("chat.done", changed);
  useRpcEvent("chat.error", changed);
  useRpcEvent("computer.step", changed);
  useRpcEvent("backgroundCommands.changed", changed);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Midnight changes the calendar cutoff.
  useEffect(() => {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
    setState((old) =>
      old.peer === peer && old.scope === scope
        ? { ...old, error: false }
        : { peer, scope, error: false },
    );
    if (peer) {
      busy.current = true;
      const query = { ...(botId ? { botId } : {}), from: auditCutoff(range) };
      void Promise.all([
        peer.call(
          "audit.counts",
          { ...query, ...(groupId ? { groupId } : {}) },
          { signal, timeoutMs: 30_000 },
        ),
        groupId
          ? Promise.resolve(0)
          : peer.call("routines.history.count", query, { signal, timeoutMs: 30_000 }),
      ])
        .then(([buckets, runs]) => {
          if (!signal.aborted)
            setState({
              peer,
              scope,
              counts: activityTypeCounts(buckets, runs, showInternal),
              error: false,
            });
        })
        .catch(() => {
          if (!lifetime.signal.aborted) setState({ peer, scope, error: true });
        })
        .finally(() => {
          if (lifetime.signal.aborted) return;
          busy.current = false;
          if (pending.current) {
            pending.current = false;
            refresh();
          }
        });
    } else setState({ peer, scope, error: true });
    return () => {
      // A scope change or unmount cancels outright; nothing queued carries over.
      lifetime.abort();
      busy.current = false;
      pending.current = false;
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [peer, scope, botId, groupId, range, showInternal, day, revision]);
  return {
    counts: state.peer === peer && state.scope === scope ? state.counts : undefined,
    error: state.peer === peer && state.scope === scope && state.error,
    refresh,
  };
}
