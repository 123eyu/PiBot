import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { type Peer, useAction, useRpc, waitRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";

export function routineError(error: unknown) {
  if (
    error instanceof RpcError &&
    (error.code === RpcErrorCodes.routineReauthorizationRequired ||
      error.message === "routine_preauth_reauthorization_required")
  )
    return "routines.reauthorizationRequired" as const;
  if (error instanceof RpcError && error.message === "routine_proposal_group_thread_unsupported")
    return "routineProposal.groupThreadUnsupported" as const;
  const cronIssues = [
    "syntax",
    "minute",
    "hour",
    "day",
    "month",
    "weekday",
    "minimum",
    "timezone",
  ] as const;
  if (error instanceof RpcError) {
    const issue = cronIssues.find((value) => error.message === `routine_cron_${value}`);
    if (issue) return `routines.cronError.${issue}` as const;
  }
  if (error instanceof RpcError && error.message === "routine_once_future")
    return "routines.once.future" as const;
  if (error instanceof RpcError && error.message === "routine_once_consumed")
    return "routines.once.consumed" as const;
  if (error instanceof RpcError && error.message === "routine_github_trigger_retired")
    return "routines.githubRetired" as const;
  if (error instanceof RpcError && error.message === "routine_trigger_missing")
    return "routines.triggerMissing" as const;
  if (error instanceof RpcError && error.message === "connection_trigger_unavailable")
    return "routines.connection.unavailable" as const;
  if (error instanceof RpcError && error.message === "connection_trigger_check_unavailable")
    return "routines.connection.missing" as const;
  if (error instanceof RpcError && error.message === "calendar_trigger_unavailable")
    return "routines.calendar.needConnection" as const;
  if (error instanceof RpcError && error.message === "routine_agent_unconfirmed")
    return "errors.agent_unconfirmed" as const;
  if (error instanceof RpcError && error.message === "routine_agent_unavailable")
    return "errors.agent_unavailable" as const;
  if (error instanceof RpcError && error.message === "routine_resume_limit")
    return "routines.resumeRun.limit" as const;
  if (error instanceof RpcError && error.message === "routine_resume_unavailable")
    return "routines.resumeRun.unavailable" as const;
  if (
    error instanceof RpcError &&
    (error.code === RpcErrorCodes.methodNotFound ||
      error.code === RpcErrorCodes.closed ||
      error.code === RpcErrorCodes.unsupported)
  )
    return "routines.unavailable" as const;
  if (error instanceof RpcError && error.code === RpcErrorCodes.invalidParams)
    return "routines.invalid" as const;
  if (error instanceof RpcError && error.code === RpcErrorCodes.noModel)
    return "errors.no_model" as const;
  if (error instanceof RpcError && error.code === RpcErrorCodes.busy)
    return "routines.busy" as const;
  if (
    (error instanceof RpcError && error.code === RpcErrorCodes.timeout) ||
    (error instanceof DOMException && error.name === "TimeoutError")
  )
    return "routines.uncertain" as const;
  return "routines.failed" as const;
}

// Ending local waiting never claims to cancel an accepted remote mutation.
export function useRoutineAction(requirePeer = true) {
  const { peer } = useRpc();
  const action = useAction();
  const owner = useRef(new AbortController());
  const [uncertain, setUncertain] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A replaced peer owns a new lifetime, even before the next action.
  useEffect(() => {
    owner.current = new AbortController();
    setUncertain(false);
    return () => owner.current.abort();
  }, [peer]);
  async function run<T>(operation: (signal: AbortSignal) => Promise<T>) {
    if (uncertain) return undefined;
    const current = owner.current;
    return action.run(
      async (lifetime) => {
        const signal = AbortSignal.any([lifetime, current.signal, AbortSignal.timeout(30_000)]);
        try {
          const result = await waitRpc(() => operation(signal), signal);
          return current.signal.aborted ? undefined : result;
        } catch (error) {
          if (current.signal.aborted) return undefined;
          throw error;
        }
      },
      (error) => {
        const key = routineError(error);
        if (key === "routines.uncertain" && !current.signal.aborted) setUncertain(true);
        return key;
      },
    );
  }
  return {
    ...action,
    run,
    uncertain,
    disabled: action.busy || uncertain || (requirePeer && !peer),
  };
}

export function useRemote<T>(load: (peer: Peer, signal: AbortSignal) => Promise<T>) {
  const { peer } = useRpc();
  const [result, setResult] = useState<{ peer: Peer; load: typeof load; value: T }>();
  const [error, setError] = useState<ReturnType<typeof routineError>>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh starts a new read and invalidates late results.
  useEffect(() => {
    const owner = new AbortController();
    setResult(undefined);
    setError(undefined);
    setLoading(true);
    if (!peer) {
      setLoading(false);
      setError("routines.unavailable");
      return;
    }
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(30_000)]);
    void waitRpc(() => load(peer, signal), signal)
      .then((next) => {
        if (!owner.signal.aborted) setResult({ peer, load, value: next });
      })
      .catch((failure: unknown) => {
        if (!owner.signal.aborted) setError(routineError(failure));
      })
      .finally(() => {
        if (!owner.signal.aborted) setLoading(false);
      });
    return () => owner.abort();
  }, [peer, load, revision]);
  const value = result?.peer === peer && result.load === load ? result.value : undefined;
  return { value, error, loading, refresh };
}

export function useRoutineRefresh(
  refresh: () => void,
  botId?: string,
  scope?: { routineId?: string; routineIds?: readonly string[]; power?: boolean },
) {
  const { peer } = useRpc();
  const routineId = scope?.routineId;
  const routineIds = scope?.routineIds;
  const power = scope?.power;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ids = routineIds ? new Set(routineIds) : undefined;
    const changed = (bot?: string, id?: string | null) => {
      const matches = id && (id === routineId || ids?.has(id));
      if (botId && bot && bot !== botId && !matches) return;
      if (routineId && id !== undefined && id !== routineId) return;
      if (ids && id !== undefined && (!id || !ids.has(id))) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        refresh();
      }, 250);
    };
    const off = [
      peer?.on("routines.changed", (e) => changed(e.botId, e.id)),
      peer?.on("routine.run", (e) => changed(e.botId, e.routineId)),
      power ? peer?.on("power.state", () => changed()) : undefined,
    ];
    return () => {
      clearTimeout(timer);
      for (const unsubscribe of off) unsubscribe?.();
    };
  }, [peer, refresh, botId, routineId, routineIds, power]);
}
