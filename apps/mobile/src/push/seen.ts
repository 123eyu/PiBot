/**
 * Event ids already announced, by a local notice or by a push the app saw. Bounded: an event is
 * only repeated within seconds (reply + task + routine for one run, or push + live event), so the
 * last few hundred ids are plenty. In memory only; replayed events after a reconnect never reach
 * the notifier (the session drops them before the UI subscribes).
 */
export class SeenEvents {
  private ids = new Set<string>();
  constructor(private readonly limit = 300) {}
  has(id: string) {
    return this.ids.has(id);
  }
  add(id: string) {
    this.ids.delete(id);
    this.ids.add(id);
    while (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value as string);
  }
}
