import type { MethodResults } from "@pibot/protocol";
import { Methods, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useEffect, useRef, useState } from "react";
import type { MobileKey } from "../../i18n/messages.ts";
import { useLinkState, useRuntime } from "../../runtime/context.tsx";
import { errorKey } from "../../runtime/errors.ts";
import { cachedRead } from "../../storage/cached-read.ts";

type EndpointPage = MethodResults["devices.endpoints"];

export function useDevicePage(after?: string, limit = 1) {
  const runtime = useRuntime();
  const { peer, status, selectedId } = useLinkState();
  const computerId = selectedId ?? "";
  const online = status === "online" && peer !== null;
  const [page, setPage] = useState<{
    value: EndpointPage;
    peer: typeof peer;
    stale: boolean;
  }>();
  const shown = useRef(page);
  shown.current = page;
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
      const key = `endpoint-devices:${limit}:${after ?? ""}`;
      const schema = Methods["devices.endpoints"].result;
      // Maintainers 2026-11-14: the device list is kept ahead (features/sync/catalog-sync.ts); online it
      // shows that copy at once, marked not current, while the computer answers.
      if (online && !shown.current)
        await cachedRead(runtime.storage.files, { computerId, online: false, key, schema }, () =>
          Promise.reject(new Error("offline")),
        ).then(
          (copy) => {
            if (!request.signal.aborted && !shown.current) setPage({ ...copy, peer: null });
          },
          () => undefined, // Nothing stored yet: the live answer below is the first one.
        );
      try {
        const result = await cachedRead(
          runtime.storage.files,
          {
            computerId,
            online,
            key,
            schema,
            signal: request.signal,
          },
          async () => {
            if (!peer || !stillCurrent()) throw new Error("offline");
            const value = await runtime.call("devices.endpoints", { after, limit }, request.signal);
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
    const off = online
      ? peer.on("devices.changed", () => {
          // Invalidate this snapshot immediately; collapse bursts into one read.
          owner?.abort();
          setBusy(true);
          clearTimeout(timer);
          timer = setTimeout(() => void load(), 200);
        })
      : undefined;
    return () => {
      clearTimeout(timer);
      owner?.abort();
      off?.();
      unsubscribe();
    };
  }, [after, attempt, computerId, limit, online, peer, runtime, status]);

  const load = () => {
    setBusy(true);
    setAttempt((n) => n + 1);
  };
  return {
    action: { busy, error },
    online,
    load,
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
