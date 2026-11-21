import type { AuditEntry } from "@pibot/protocol";

type Pager<T> = {
  sources: Map<string, AuditEntry>;
  more: boolean;
  next(signal: AbortSignal): Promise<T[]>;
};

/** A refresh must reach the old window before resuming its older-history cursor. */
export class AuditRefreshPager<T extends { at: string; id: string } = AuditEntry> {
  private history: Pager<T>;
  private bridge?: { pager: Pager<T>; boundary?: T };
  private pendingHead = false;
  sources: Map<string, AuditEntry>;
  constructor(private readonly create: () => Pager<T>) {
    this.history = create();
    this.sources = this.history.sources;
  }
  get more() {
    return !!this.bridge || this.pendingHead || this.history.more;
  }
  async next(signal: AbortSignal, boundary?: T, fresh = false) {
    if (fresh && this.bridge) this.pendingHead = true;
    if ((fresh || this.pendingHead) && !this.bridge) {
      this.bridge = { pager: this.create(), boundary };
      this.pendingHead = false;
    }
    const bridge = this.bridge;
    const pager = bridge?.pager ?? this.history;
    const page = await pager.next(signal);
    this.sources = pager.sources;
    if (bridge) {
      const anchor = bridge.boundary;
      const reached =
        !anchor ||
        page.some(
          (entry) =>
            entry.at < anchor.at ||
            (entry.at === anchor.at && entry.id.localeCompare(anchor.id) <= 0),
        );
      if (reached || !pager.more) {
        // An empty initial window has no older cursor to preserve.
        if (!anchor) this.history = pager;
        this.bridge = undefined;
      }
    }
    return page;
  }
}
