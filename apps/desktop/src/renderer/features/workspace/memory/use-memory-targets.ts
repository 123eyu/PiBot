import type { InboxItem, Memory } from "@pibot/protocol";
import { useRpc } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";

type Targets = Map<string, { memories?: Memory[]; loading: boolean }>;

// One read per Bot, with bounded concurrency; a failed target read cannot authorize a mutation.
export function useMemoryTargets(items: InboxItem[], revision: number) {
  const { peer } = useRpc();
  const ids = JSON.stringify([
    ...new Set(
      items.flatMap((item) =>
        item.kind === "memory" && item.proposal.action !== "add" ? [item.proposal.botId] : [],
      ),
    ),
  ]);
  const [state, setState] = useState<{
    peer: typeof peer;
    ids: string;
    revision: number;
    targets: Targets;
  }>();
  useEffect(() => {
    let active = true;
    const botIds: string[] = JSON.parse(ids);
    const targets: Targets = new Map(botIds.map((id) => [id, { loading: true }]));
    setState({ peer, ids, revision, targets: new Map(targets) });
    const read = async () => {
      while (active && peer && botIds.length) {
        const botId = botIds.shift();
        if (!botId) return;
        try {
          const memories = await peer.call("memory.list", { botId });
          if (memories.some((memory) => memory.scope !== "user" && memory.botId !== botId))
            throw new Error("Memory target mismatch");
          targets.set(botId, { memories, loading: false });
        } catch {
          // Read errors leave acceptance disabled; Inbox retry refreshes these targets too.
          targets.set(botId, { loading: false });
        }
        if (active) setState({ peer, ids, revision, targets: new Map(targets) });
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, botIds.length) }, read));
    return () => {
      active = false;
    };
  }, [peer, ids, revision]);
  return state?.peer === peer && state.ids === ids && state.revision === revision
    ? state.targets
    : undefined;
}
