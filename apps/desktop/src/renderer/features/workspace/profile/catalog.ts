import { chatReadCache } from "@pibot/client-core";
import type { ModelInfo, Provider } from "@pibot/protocol";
import { type Peer, useRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useState } from "react";

// The chat session reads this same list while a conversation mounts; joining its shared lane
// saves one duplicate call per switch. The lane never serves a read issued before a change event.
function availableModels(peer: Peer, signal: AbortSignal) {
  const direct = () => peer.call("models.list", { availableOnly: true }, { signal });
  const reads = chatReadCache(peer);
  if (reads.isDisposed()) return direct();
  return reads
    .read(
      "models:available",
      (read) => peer.call("models.list", { availableOnly: true }, { signal: read }),
      signal,
    )
    .catch((error: unknown) => {
      // A full lane table is the cache's back-pressure, not a catalog failure.
      if (!signal.aborted && error instanceof Error && error.message === "Read capacity reached")
        return direct();
      throw error;
    });
}

export function useCatalog() {
  const { peer } = useRpc();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision triggers an explicit retry or event refresh.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    if (!peer) return;
    const abort = new AbortController();
    void Promise.all([availableModels(peer, abort.signal), peer.call("providers.list", undefined)])
      .then(([models, providers]) => {
        if (active) {
          setModels(models);
          setProviders(providers);
        }
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const off = peer.on("providers.changed", reload);
    return () => {
      active = false;
      abort.abort();
      off();
    };
  }, [peer, revision, reload]);
  return { models, providers, loading, error, reload };
}
