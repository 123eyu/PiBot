import type { AuditEntry } from "@pibot/protocol";
import { type ActivityEntry, auditActivity, compareActivity, runActivity } from "./activity.ts";
import type { RoutineHistoryPager } from "./history-pager.ts";
import type { AuditPager } from "./pager.ts";

type Feed = {
  buffer: ActivityEntry[];
  more(): boolean;
  read(signal: AbortSignal): Promise<ActivityEntry[]>;
};
/** Two genuine sources, with independent raw cursors and one deterministic display order. */
export class ActivityPager {
  readonly sources: Map<string, AuditEntry>;
  private readonly feeds: Feed[];
  constructor(
    audit: AuditPager,
    private readonly history?: RoutineHistoryPager,
    private readonly visibleLimit = 50,
  ) {
    this.sources = audit.sources;
    this.feeds = [
      {
        buffer: [],
        more: () => audit.more,
        read: async (signal) => (await audit.next(signal)).map(auditActivity),
      },
    ];
    if (history)
      this.feeds.push({
        buffer: [],
        more: () => history.more,
        read: async (signal) => (await history.next(signal)).map(runActivity),
      });
  }
  get more() {
    return this.feeds.some((feed) => feed.buffer.length || feed.more());
  }
  async next(signal: AbortSignal) {
    const result: ActivityEntry[] = [];
    const consumed = new Map<Feed, ActivityEntry[]>();
    let rounds = 0;
    try {
      while (result.length < this.visibleLimit) {
        signal.throwIfAborted();
        const empty = this.feeds.filter((feed) => feed.more() && !feed.buffer.length);
        if (empty.length) {
          if (rounds++ >= 5) break;
          const reads = await Promise.allSettled(
            empty.map(async (feed) => {
              feed.buffer.push(...(await feed.read(signal)));
            }),
          );
          const failure = reads.find((read) => read.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
          // Unknown heads must be scanned before emitting the other source's older entries.
          if (this.feeds.some((feed) => feed.more() && !feed.buffer.length)) continue;
        }
        const feed = this.feeds
          .filter((feed) => feed.buffer.length)
          .sort((a, b) =>
            compareActivity(a.buffer[0] as ActivityEntry, b.buffer[0] as ActivityEntry),
          )[0];
        const entry = feed?.buffer.shift();
        if (!entry || !feed) break;
        result.push(entry);
        const staged = consumed.get(feed);
        if (staged) staged.push(entry);
        else consumed.set(feed, [entry]);
      }
      // Buffered pages can outlive a run. Reread only emitted IDs before committing a page.
      const ids = result
        .filter((entry) => entry.type === "routine-run")
        .map((entry) => entry.run.id);
      const updates = new Map(
        (this.history ? await this.history.reread(ids, signal) : []).map((run) => [
          run.id,
          runActivity(run),
        ]),
      );
      return result.map((entry) =>
        entry.type === "routine-run" ? (updates.get(entry.run.id) ?? entry) : entry,
      );
    } catch (error) {
      for (const [feed, entries] of consumed) feed.buffer.unshift(...entries);
      throw error;
    }
  }
}
