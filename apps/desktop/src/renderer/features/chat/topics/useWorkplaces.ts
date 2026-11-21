import type { ChatPeer } from "@pibot/client-core";
import { chatReadCache } from "@pibot/client-core";
import type { Workplaces } from "@pibot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

export function useWorkplaces(peer: ChatPeer, botId?: string) {
  const reads = chatReadCache(peer);
  const key = JSON.stringify(["workplaces", botId]);
  const [snapshot, setSnapshot] = useState<{ key: string; peer: ChatPeer; data: Workplaces }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [changing, setChanging] = useState(false);
  const identity = useRef({ peer, botId });
  if (identity.current.peer !== peer || identity.current.botId !== botId)
    identity.current = { peer, botId };
  const generation = useRef(0);
  const locked = useRef(false);
  const abort = useRef<AbortController | undefined>(undefined);
  const run = useCallback(
    async (operation: () => Promise<Workplaces>) => {
      if (!botId || locked.current) return;
      locked.current = true;
      setChanging(true);
      const owner = identity.current;
      ++generation.current;
      abort.current?.abort();
      setSnapshot(undefined);
      setBusy(true);
      setError(false);
      try {
        const data = await operation();
        if (owner === identity.current) {
          reads.rememberPreview(key, data);
          setSnapshot({ peer, key, data });
        }
      } catch {
        if (owner === identity.current) setError(true);
      } finally {
        if (owner === identity.current) {
          locked.current = false;
          setChanging(false);
          setBusy(false);
        }
      }
    },
    [peer, botId, key, reads],
  );
  const refresh = useCallback(async () => {
    if (!botId || locked.current) return;
    const version = ++generation.current;
    const read = new AbortController();
    abort.current?.abort();
    abort.current = read;
    setBusy(true);
    setError(false);
    try {
      const data = await reads.read(
        key,
        (signal) => peer.call("workplaces.list", { botId }, { signal }),
        read.signal,
      );
      if (version !== generation.current || read.signal.aborted) return;
      reads.rememberPreview(key, data);
      setSnapshot({ peer, key, data });
    } catch {
      if (!read.signal.aborted && version === generation.current) setError(true);
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }, [peer, botId, reads, key]);
  useEffect(() => {
    identity.current = { peer, botId };
    setSnapshot(undefined);
    locked.current = false;
    setChanging(false);
    setError(false);
    void refresh();
    // Re-read in place on events that can move folders; the shown folder stays until replaced.
    const off = [
      peer.on("bots.changed", (event) => {
        if (event.botId === botId) void refresh();
      }),
      peer.on("permissions.changed", () => void refresh()),
    ];
    return () => {
      for (const unsubscribe of off) unsubscribe();
      identity.current = { peer, botId };
      generation.current++;
      abort.current?.abort();
      locked.current = false;
    };
  }, [peer, botId, refresh]);
  const confirmed = !changing && snapshot?.peer === peer && snapshot.key === key;
  const data = changing ? undefined : confirmed ? snapshot.data : reads.preview<Workplaces>(key);
  return { data, confirmed, busy, changing, error, run, refresh };
}
export type WorkplaceState = ReturnType<typeof useWorkplaces>;
