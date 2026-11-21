import { createContext, type ReactNode, useContext, useState, useSyncExternalStore } from "react";

export interface RestoreRequest {
  requestId: string;
  id: string;
  expectedVersion: number;
  itemIds: string[];
}
export function createRestoreRequests() {
  const entries = new Map<string, RestoreRequest>(),
    listeners = new Set<() => void>();
  const changed = () => {
    for (const notify of listeners) notify();
  };
  return {
    get: (key: string) => entries.get(key),
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    begin: (key: string, input: Omit<RestoreRequest, "requestId">) => {
      const prior = entries.get(key);
      if (prior) return prior;
      if (entries.size >= 100) return undefined;
      const value = { ...input, itemIds: [...input.itemIds], requestId: crypto.randomUUID() };
      entries.set(key, value);
      changed();
      return value;
    },
    clear: (key: string, requestId: string) => {
      if (entries.get(key)?.requestId === requestId) {
        entries.delete(key);
        changed();
      }
    },
  };
}
const Requests = createContext<ReturnType<typeof createRestoreRequests> | null>(null);
/** Keep uncertain UUIDs across pane/topic navigation without a plaintext disk cache. */
export function RestoreRequestProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createRestoreRequests);
  return <Requests.Provider value={store}>{children}</Requests.Provider>;
}
export function useRestoreRequest(key: string) {
  const store = useContext(Requests);
  if (!store) throw Error("Restore request provider unavailable");
  const pending = useSyncExternalStore(
    store.subscribe,
    () => store.get(key),
    () => store.get(key),
  );
  return { pending, store, key };
}
