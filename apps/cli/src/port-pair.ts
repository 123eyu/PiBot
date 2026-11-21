import type { Port } from "@pibot/protocol";

/**
 * The brain talks to its caller over a `Port`; in the app that is an Electron MessagePort. A pair of
 * in-memory ports keeps the same wire contract (structured clone, delivered later) in one process.
 */
export function portPair(): [Port, Port] {
  const listeners: Array<Set<(value: unknown) => void>> = [new Set(), new Set()];
  return [0, 1].map((side): Port => {
    return {
      post(value) {
        const copy = structuredClone(value);
        queueMicrotask(() => {
          for (const listener of listeners[1 - side] ?? []) listener(copy);
        });
      },
      onMessage(listener) {
        listeners[side]?.add(listener);
        return () => {
          listeners[side]?.delete(listener);
        };
      },
    };
  }) as [Port, Port];
}
