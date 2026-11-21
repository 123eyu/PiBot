import type { ChatPeer } from "@pibot/client-core";
import type { Workplaces } from "@pibot/protocol";
import { waitRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useState } from "react";
import type { GroupSnapshot } from "../data.ts";

export function useGroupWorkplaces(peer: ChatPeer, data: GroupSnapshot) {
  const key = JSON.stringify(data.group?.members.map((m) => m.botId) ?? []);
  const revision = data.group?.updatedAt;
  const [version, setVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    peer: ChatPeer;
    key: string;
    places: Map<string, Workplaces>;
    error: boolean;
  }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: group metadata and explicit retry invalidate directory metadata
  useEffect(() => {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
    const ids = JSON.parse(key) as string[];
    void Promise.all(
      ids.map(
        async (botId) =>
          [
            botId,
            await waitRpc(() => peer.call("workplaces.list", { botId }, { signal }), signal),
          ] as const,
      ),
    )
      .then((entries) => {
        if (!signal.aborted) setSnapshot({ peer, key, places: new Map(entries), error: false });
      })
      .catch(() => {
        if (!lifetime.signal.aborted) setSnapshot({ peer, key, places: new Map(), error: true });
      });
    const off = peer.on("bots.changed", (e) => {
      if (ids.includes(e.botId)) {
        lifetime.abort();
        setVersion((v) => v + 1);
      }
    });
    return () => {
      lifetime.abort();
      off();
    };
  }, [peer, key, revision, version]);
  // Stable, so callbacks built on it can reach memoized message rows without re-rendering them.
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return {
    snapshot: snapshot?.peer === peer && snapshot.key === key ? snapshot : undefined,
    refresh,
  };
}
