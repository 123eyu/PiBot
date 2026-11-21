import { Methods, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useEffect, useState } from "react";
import type { MobileKey } from "../../i18n/messages.ts";
import { useLinkState, useRuntime } from "../../runtime/context.tsx";
import { errorKey } from "../../runtime/errors.ts";
import { cachedRead } from "../../storage/cached-read.ts";
import { type EndpointPage, endpointPageSize } from "./model.ts";

export function useEndpointPage(computerId: string, after: string | undefined, endpointId: string) {
  const runtime = useRuntime();
  const { peer, status } = useLinkState();
  const online = status === "online" && peer !== null;
  const [page, setPage] = useState<{
    value: EndpointPage;
    peer: typeof peer;
    stale: boolean;
  }>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<MobileKey>();
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly restarts the load.
  useEffect(() => {
    let owner: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stillCurrent = () => {
      const current = runtime.getSnapshot();
      return (
        current.peer === peer && current.selectedId === computerId && current.status === status
      );
    };
    const unsubscribe = runtime.subscribe(() => {
      if (!stillCurrent()) owner?.abort();
    });
    async function load() {
      if (!stillCurrent()) return;
      owner?.abort();
      const request = new AbortController();
      owner = request;
      setBusy(true);
      setError(undefined);
      try {
        const result = await cachedRead(
          runtime.storage.files,
          {
            computerId,
            online,
            key: `endpoint-capabilities:${endpointId}:${after ?? ""}`,
            schema: Methods["endpoints.list"].result,
            signal: request.signal,
          },
          async () => {
            if (!peer || !stillCurrent()) throw new Error("offline");
            const value = await runtime.call(
              "endpoints.list",
              { after, limit: endpointPageSize, endpointId },
              request.signal,
            );
            request.signal.throwIfAborted();
            return value;
          },
        );
        if (!request.signal.aborted) setPage({ ...result, peer });
      } catch (cause) {
        if (!request.signal.aborted)
          setError(
            !online
              ? "endpointsNoCache"
              : cause instanceof RpcError && cause.code === RpcErrorCodes.methodNotFound
                ? "endpointsOldComputer"
                : errorKey(cause),
          );
      } finally {
        if (!request.signal.aborted) setBusy(false);
      }
    }
    void load();
    const changed = () => {
      owner?.abort();
      setBusy(true);
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 200);
    };
    const off = online
      ? [peer.on("endpoints.changed", changed), peer.on("devices.changed", changed)]
      : [];
    return () => {
      clearTimeout(timer);
      owner?.abort();
      for (const unsubscribe of off) unsubscribe();
      unsubscribe();
    };
  }, [after, attempt, computerId, endpointId, online, peer, runtime, status]);

  return {
    value: page?.value,
    writable: online && page?.peer === peer && !page.stale && !busy && !error,
    stale: !!page && (!online || page.stale || page.peer !== peer || !!error),
    busy,
    error,
    refresh: () => {
      setBusy(true);
      setAttempt((n) => n + 1);
    },
  };
}
