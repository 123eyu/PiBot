import { type Peer, useRpc } from "@pibot/renderer-kit";
import { useMemo, useSyncExternalStore } from "react";

/**
 * Per-topic counts of automatic continuations an earlier process left unfinished. The
 * brain scans once at startup, so a snapshot plus the `continuations.pending` events is complete.
 */
class PendingContinuationsStore {
  private counts = new Map<string, number>();
  private listeners = new Set<() => void>();
  private off?: () => void;
  private epoch = 0;
  constructor(private readonly peer: Peer) {}
  count = (conversationId: string | undefined) =>
    conversationId ? (this.counts.get(conversationId) ?? 0) : 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };
  private set(conversationId: string, count: number) {
    const next = new Map(this.counts);
    if (count) next.set(conversationId, count);
    else next.delete(conversationId);
    this.counts = next;
    for (const listener of this.listeners) listener();
  }
  private start() {
    const epoch = ++this.epoch;
    const live = new Set<string>();
    this.off = this.peer.on("continuations.pending", ({ conversationId, count }) => {
      live.add(conversationId);
      this.set(conversationId, count);
    });
    const load = async (after?: string) => {
      const page = await this.peer.call("continuations.list", after ? { after } : {});
      if (epoch !== this.epoch) return;
      // A live event is newer than the snapshot page that was requested before it.
      for (const item of page.items)
        if (!live.has(item.conversationId)) this.set(item.conversationId, item.count);
      if (page.nextAfter) await load(page.nextAfter);
    };
    void load().catch(() => {
      // Advisory only: without the snapshot the prompt stays hidden and nothing runs on its own.
    });
  }
  private stop() {
    this.epoch++;
    this.off?.();
    this.off = undefined;
  }
}

const stores = new WeakMap<Peer, PendingContinuationsStore>();
export function usePendingContinuations(conversationId: string | undefined): number {
  const { peer } = useRpc();
  const store = useMemo(() => {
    if (!peer) return undefined;
    let found = stores.get(peer);
    if (!found) {
      found = new PendingContinuationsStore(peer);
      stores.set(peer, found);
    }
    return found;
  }, [peer]);
  const snapshot = () => store?.count(conversationId) ?? 0;
  return useSyncExternalStore(store?.subscribe ?? (() => () => {}), snapshot, snapshot);
}
