import type { RuntimeHealth } from "@pibot/protocol";
import { type Peer, useRpc } from "@pibot/renderer-kit";
import { useMemo, useSyncExternalStore } from "react";

const healthy: RuntimeHealth = { healthy: true, reason: null, botIds: [] };

/** Failures only clear on restart, so an earlier Bot list must survive a later global failure. */
function merge(previous: RuntimeHealth, next: RuntimeHealth): RuntimeHealth {
  if (next.healthy) return healthy;
  return {
    healthy: false,
    reason: next.reason,
    botIds: [...new Set([...previous.botIds, ...next.botIds])],
  };
}

class RuntimeHealthStore {
  private state: RuntimeHealth = healthy;
  private listeners = new Set<() => void>();
  private off?: () => void;
  private epoch = 0;
  constructor(private readonly peer: Peer) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };
  private set(next: RuntimeHealth) {
    this.state = merge(this.state, next);
    for (const listener of this.listeners) listener();
  }
  private start() {
    const epoch = ++this.epoch;
    this.off = this.peer.on("runtime.health", (next) => this.set(next));
    void this.peer
      .call("runtime.health.get", undefined)
      .then((next) => {
        // A live event is newer than a snapshot requested before it.
        if (epoch === this.epoch) this.set(next);
      })
      .catch(() => {
        // Advisory only: the warning stays hidden rather than blocking the sidebar or chat.
      });
  }
  private stop() {
    this.epoch++;
    this.off?.();
    this.off = undefined;
    // The snapshot is kept: a drain failure is permanent, and clearing it would flash the banner
    // away whenever the last subscriber (for example the chat view) unmounts.
  }
}

const stores = new WeakMap<Peer, RuntimeHealthStore>();
const healthySnapshot = () => healthy;
export function useRuntimeHealth(): RuntimeHealth {
  const { peer } = useRpc();
  const store = useMemo(() => {
    if (!peer) return undefined;
    let found = stores.get(peer);
    if (!found) {
      found = new RuntimeHealthStore(peer);
      stores.set(peer, found);
    }
    return found;
  }, [peer]);
  return useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.snapshot ?? healthySnapshot,
    store?.snapshot ?? healthySnapshot,
  );
}
