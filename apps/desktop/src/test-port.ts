import type { Port } from "@pibot/protocol";

export function memoryPorts(): [Port, Port] {
  const listeners = [new Set<(message: unknown) => void>(), new Set<(message: unknown) => void>()];
  const port = (index: number): Port => ({
    post(message) {
      const snapshot = structuredClone(message);
      queueMicrotask(() => {
        for (const receive of listeners[1 - index] ?? []) receive(snapshot);
      });
    },
    onMessage(receive) {
      listeners[index]?.add(receive);
      return () => {
        listeners[index]?.delete(receive);
      };
    },
  });
  return [port(0), port(1)];
}
