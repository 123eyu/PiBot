import type { MethodParams, MethodResults } from "@pibot/protocol";
import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";

export type EndpointRow = MethodResults["endpoints.list"]["items"][number];
export type EndpointChange = MethodParams["endpoints.capability.set"];

export function useEndpointCapabilities() {
  const { peer } = useRpc();
  const [rows, setRows] = useState<EndpointRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const lane = useRef<{
    peer: typeof peer;
    lifetime: AbortController;
    read?: AbortController;
    write?: boolean;
    pages: number;
  }>(undefined);
  const load = useCallback(
    async (pages?: number) => {
      const owner = lane.current;
      if (!peer || !owner || owner.peer !== peer || owner.lifetime.signal.aborted) return;
      const count = pages ?? owner.pages;
      owner.read?.abort();
      const read = new AbortController();
      owner.read = read;
      const signal = AbortSignal.any([
        read.signal,
        owner.lifetime.signal,
        AbortSignal.timeout(15_000),
      ]);
      setLoading(true);
      try {
        const loaded = new Map<string, EndpointRow>();
        let after: string | null = null;
        for (let page = 0; page < count; page++) {
          const response: MethodResults["endpoints.list"] = await peer.call(
            "endpoints.list",
            { after: after ?? undefined, limit: 50 },
            { signal },
          );
          for (const row of response.items)
            loaded.set(`${row.endpointId}:${row.capabilityId}`, row);
          after = response.nextAfter;
          if (!after) break;
        }
        signal.throwIfAborted();
        owner.pages = count;
        setRows([...loaded.values()]);
        setNext(after);
        setFailed(false);
      } catch {
        if (owner.read === read && !owner.lifetime.signal.aborted) setFailed(true);
      } finally {
        if (owner.read === read && !owner.lifetime.signal.aborted) setLoading(false);
      }
    },
    [peer],
  );
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refresh = () => {
    if (refreshTimer.current !== undefined) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      if (!lane.current?.write) void load();
    }, 100);
  };
  useRpcEvent("endpoints.changed", refresh);
  useRpcEvent("devices.changed", refresh);
  useEffect(() => {
    const lifetime = new AbortController();
    lane.current = { peer, lifetime, pages: 1 };
    setRows([]);
    setNext(null);
    setFailed(false);
    setSaving(false);
    setSaveFailed(false);
    if (peer) void load();
    else setLoading(false);
    const focus = () => {
      if (!lane.current?.write) void load();
    };
    window.addEventListener("focus", focus);
    return () => {
      lifetime.abort();
      clearTimeout(refreshTimer.current);
      refreshTimer.current = undefined;
      window.removeEventListener("focus", focus);
    };
  }, [peer, load]);

  async function save(change: EndpointChange) {
    const owner = lane.current;
    if (!peer || !owner || owner.peer !== peer || owner.write || owner.lifetime.signal.aborted)
      return false;
    owner.write = true;
    setSaving(true);
    setSaveFailed(false);
    let saved = false;
    try {
      await peer.call("endpoints.capability.set", change, {
        signal: AbortSignal.any([owner.lifetime.signal, AbortSignal.timeout(10_000)]),
      });
      saved = true;
    } catch {
      if (!owner.lifetime.signal.aborted) setSaveFailed(true);
    } finally {
      if (!owner.lifetime.signal.aborted) {
        // On timeout the change may already have landed. Re-read before offering any retry.
        await load();
        owner.write = false;
        if (!owner.lifetime.signal.aborted) setSaving(false);
      }
    }
    return saved && !owner.lifetime.signal.aborted;
  }
  return {
    rows: lane.current?.peer === peer ? rows : [],
    loading,
    failed,
    saving,
    saveFailed,
    save,
    connected: !!peer && lane.current?.peer === peer,
    hasMore: !!next,
    reload: () => load(),
    more: () => load((lane.current?.pages ?? 1) + 1),
  };
}
