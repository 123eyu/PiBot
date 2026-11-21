import { RpcError, RpcErrorCodes } from "@pibot/credentials-contract/full";
import { type Peer, useRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useState } from "react";

export function secretReadError(error: unknown) {
  if (error instanceof RpcError) {
    if (error.message === "connector_credential_requires_secret_settings")
      return "connectors.secretSettingsRequired" as const;
    if (error.code === RpcErrorCodes.connectorStale) return "connectors.stale" as const;
    if (error.code === RpcErrorCodes.pluginImportCommitted) return "connectors.committed" as const;
    if (
      error.code === RpcErrorCodes.pluginImportInvalid ||
      error.code === RpcErrorCodes.invalidParams
    )
      return "connectors.invalid" as const;
    if (error.code === RpcErrorCodes.connectorUnavailable) return "connectors.unavailable" as const;
    if (error.code === RpcErrorCodes.closed) return "connectors.offline" as const;
    if (error.code === RpcErrorCodes.busy) return "connectors.busy" as const;
    if (error.code === RpcErrorCodes.timeout) return "connectors.timeout" as const;
  }
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "connectors.timeout" as const;
  return "connectors.failed" as const;
}

export function useSecretRead<T>(load: (peer: Peer, signal: AbortSignal) => Promise<T>) {
  const { peer } = useRpc();
  const [result, setResult] = useState<{ peer: Peer; load: typeof load; value: T }>();
  const [error, setError] = useState<ReturnType<typeof secretReadError>>();
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A refresh invalidates in-flight snapshots.
  useEffect(() => {
    const owner = new AbortController();
    setError(undefined);
    setLoading(!!peer);
    if (!peer) return;
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(15_000)]);
    void load(peer, signal)
      .then((value) => {
        if (!owner.signal.aborted) setResult({ peer, load, value });
      })
      .catch((failure: unknown) => {
        if (!owner.signal.aborted) setError(secretReadError(failure));
      })
      .finally(() => {
        if (!owner.signal.aborted) setLoading(false);
      });
    return () => owner.abort();
  }, [peer, load, version]);
  const value = result?.peer === peer && result.load === load ? result.value : undefined;
  return { value, error: peer ? error : ("connectors.offline" as const), loading, refresh };
}

/** One bounded page at a time; changing snapshots retires every old cursor. */
export function useSecretPage<T>(
  load: (
    peer: Peer,
    signal: AbortSignal,
    cursor?: string,
  ) => Promise<{ items: T[]; nextCursor: string | null }>,
  snapshot: number,
  resetOnChange = true,
) {
  const [position, setPosition] = useState<{ snapshot: number; cursors: (string | undefined)[] }>({
    snapshot,
    cursors: [undefined],
  });
  const cursors = !resetOnChange || position.snapshot === snapshot ? position.cursors : [undefined];
  const cursor = cursors.at(-1);
  const read = useCallback(
    (peer: Peer, signal: AbortSignal) => load(peer, signal, cursor),
    [load, cursor],
  );
  const remote = useSecretRead(read);
  const refresh = remote.refresh;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Even an unchanged first-page cursor needs a new snapshot.
  useEffect(() => refresh(), [snapshot, refresh]);
  return {
    ...remote,
    previous:
      cursors.length > 1
        ? () => setPosition({ snapshot, cursors: cursors.slice(0, -1) })
        : undefined,
    next: remote.value?.nextCursor
      ? () =>
          setPosition({ snapshot, cursors: [...cursors, remote.value?.nextCursor ?? undefined] })
      : undefined,
  };
}
