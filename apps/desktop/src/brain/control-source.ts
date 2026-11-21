import { RpcError, RpcErrorCodes } from "@pibot/protocol";

// Input ownership remains here until every subscribed async consumer has drained.
export function createControlSource<T>(key: (value: T) => string | undefined, failed?: () => void) {
  const listeners = new Set<(value: T) => void | Promise<void>>();
  const pending: T[] = [];
  let closed = false;
  let accepting = true;
  let running: Promise<void> | undefined;
  let failure: unknown;
  function pump() {
    if (running || closed || !listeners.size || !pending.length) return;
    running = (async () => {
      while (!closed && listeners.size && pending.length) {
        const next = pending.shift();
        if (next === undefined) break;
        for (const listener of [...listeners]) {
          if (listeners.has(listener)) await listener(next);
        }
      }
    })()
      .catch((error: unknown) => {
        failure = error;
        closed = true;
        pending.length = 0;
        failed?.();
      })
      .finally(() => {
        running = undefined;
        pump();
      });
  }
  return {
    isIdle: () => pending.length === 0 && !running,
    push(value: T) {
      if (!accepting || closed)
        throw failure ?? new RpcError(RpcErrorCodes.closed, "control_source_closed");
      const id = key(value);
      // Coalesce snapshots only; suspend/resume and developer commands retain order.
      const index = id === undefined ? -1 : pending.findIndex((entry) => key(entry) === id);
      if (index >= 0) pending.splice(index, 1);
      if (pending.length >= 128) throw new RpcError(RpcErrorCodes.busy, "control_source_overflow");
      pending.push(structuredClone(value));
      pump();
    },
    subscribe(listener: (value: T) => void | Promise<void>) {
      if (!accepting || closed) throw new RpcError(RpcErrorCodes.closed, "control_source_closed");
      listeners.add(listener);
      pump();
      return () => {
        listeners.delete(listener);
      };
    },
    async stop() {
      accepting = false;
      // Consumers remain alive until their already accepted work completes.
      pump();
      await running;
      closed = true;
      pending.length = 0;
      listeners.clear();
      if (failure) throw failure;
    },
  };
}
