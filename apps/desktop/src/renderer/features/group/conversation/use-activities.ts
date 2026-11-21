import type { ChatPeer } from "@pibot/client-core";
import { emptyActivity, groupActivity } from "@pibot/client-core";
import type { Message } from "@pibot/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ActivityState, LocalActivity } from "../../chat/tools/local-activity.ts";

export function useGroupActivities(peer: ChatPeer, botIds: string[]) {
  const key = JSON.stringify([...new Set(botIds)].sort());
  const stores = useMemo(
    () => new Map((JSON.parse(key) as string[]).map((id) => [id, new LocalActivity(peer, id)])),
    [peer, key],
  );
  const [snapshot, setSnapshot] = useState({ stores, states: new Map<string, ActivityState>() });
  const cache = useRef(new Map<string, Map<string, ActivityState>>());
  const grouped = useMemo(() => {
    if (snapshot.stores !== stores) return new Map<string, Map<string, ActivityState>>();
    const next = new Map(
      [...snapshot.states].map(([id, state]) => [
        id,
        groupActivity(state, cache.current.get(id) ?? new Map()),
      ]),
    );
    cache.current = next;
    return next;
  }, [snapshot, stores]);
  useEffect(() => {
    let active = true;
    const update = () => {
      if (active)
        setSnapshot({
          stores,
          states: new Map([...stores].map(([id, store]) => [id, store.getSnapshot()])),
        });
    };
    const off = [...stores.values()].flatMap((store) => [store.subscribe(update), store.start()]);
    update();
    return () => {
      active = false;
      for (const unsubscribe of off) unsubscribe();
    };
  }, [stores]);
  return {
    approvals:
      snapshot.stores === stores ? [...snapshot.states.values()].flatMap((s) => s.approvals) : [],
    forMessage(message: Message) {
      const state = message.botId ? grouped.get(message.botId)?.get(message.id) : undefined;
      const store = message.botId ? stores.get(message.botId) : undefined;
      return {
        state:
          state?.tools.every((t) => t.runId === message.runId) &&
          state.approvals.every((a) => a.runId === message.runId && a.botId === message.botId) &&
          (!state.runActivity || state.runActivity.runId === message.runId)
            ? state
            : emptyActivity,
        refresh: store?.refresh,
        decide: store?.resolve,
      };
    },
    error: snapshot.stores === stores && [...snapshot.states.values()].some((s) => s.error),
    refresh: async () => {
      await Promise.all([...stores.values()].map((s) => s.refresh()));
    },
  };
}
