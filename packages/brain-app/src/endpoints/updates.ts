/** Session owners unsubscribe before retiring their authenticated path. */
export class EndpointCapabilityUpdates {
  private readonly listeners = new Map<string, Set<(ids: readonly string[]) => void>>();
  constructor(private readonly warn: () => void) {}
  subscribe(id: string, listener: (ids: readonly string[]) => void) {
    const entries = this.listeners.get(id) ?? new Set();
    entries.add(listener);
    this.listeners.set(id, entries);
    return () => {
      entries.delete(listener);
      if (!entries.size) this.listeners.delete(id);
    };
  }
  publish(id: string, ids: readonly string[]) {
    for (const listener of this.listeners.get(id) ?? []) {
      try {
        listener(ids);
      } catch {
        this.warn();
      } // Committed registry checks still apply; the authenticated session owns delivery recovery.
    }
  }
  dispose() {
    this.listeners.clear();
  }
}
