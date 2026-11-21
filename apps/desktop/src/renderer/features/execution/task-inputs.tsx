import { createContext, type ReactNode, useContext, useState, useSyncExternalStore } from "react";

interface PendingInput {
  id: string;
  text: string;
  state: "unknown" | "deferred";
}
function createInputStore() {
  const entries = new Map<string, PendingInput>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const notify of listeners) notify();
  };
  return {
    get: (key: string) => entries.get(key),
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    begin(key: string, text: string): PendingInput | undefined {
      const prior = entries.get(key);
      if (prior) return prior;
      // Never evict an uncertain receipt: retrying with a new UUID could duplicate delivery.
      if (entries.size >= 100 || text.length > 8_000) return undefined;
      const value: PendingInput = { id: crypto.randomUUID(), text, state: "unknown" };
      entries.set(key, value);
      changed();
      return value;
    },
    deferred(key: string, id: string) {
      const prior = entries.get(key);
      if (prior?.id !== id) return;
      entries.set(key, { ...prior, state: "deferred" });
      changed();
    },
    clear(key: string, id: string) {
      if (entries.get(key)?.id !== id) return;
      entries.delete(key);
      changed();
    },
  };
}
const Inputs = createContext<ReturnType<typeof createInputStore> | null>(null);

/** Renderer-lifetime receipts survive closing details and topic navigation; no plaintext disk cache. */
export function TaskInputProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createInputStore);
  return <Inputs.Provider value={store}>{children}</Inputs.Provider>;
}
export function useTaskInput(key: string) {
  const store = useContext(Inputs);
  if (!store) throw new Error("Task input provider unavailable");
  const pending = useSyncExternalStore(
    store.subscribe,
    () => store.get(key),
    () => store.get(key),
  );
  return { pending, store, key };
}
