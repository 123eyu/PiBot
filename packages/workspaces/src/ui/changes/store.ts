import type { ChatPeer } from "@pibot/client-core";
import type { TranslationKey } from "@pibot/i18n";
import type { ChangesStatus, ChangesTurn, EventPayloads } from "@pibot/workspaces-contract/full";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { changesErrorKey, fromChangeFile, type ListFile } from "./model.ts";

export interface ChangesTarget {
  conversationKey: string;
  topicId?: string;
  rootId?: string;
}
const PAGE = 2000;
/** 10 pages = 20,000 files; the brain's own status cap is far above anything a list can show. */
const MAX_PAGES = 10;

export interface SourceState {
  status?: ChangesStatus;
  files: ListFile[];
  loading: boolean;
  error?: TranslationKey;
  /** Not every page was read (summary mode, or more than MAX_PAGES pages). */
  partial: boolean;
  /** Every page was wanted but the list stopped at MAX_PAGES. */
  capped: boolean;
}

export function sameConversation(
  event: EventPayloads["changes.changed"],
  target: Pick<ChangesTarget, "conversationKey" | "topicId">,
) {
  return event.conversationKey === target.conversationKey && event.topicId === target.topicId;
}

/**
 * Status for one folder of one conversation. The header pill needs only totals (one-file page);
 * an open sidebar asks for every page. Refreshes are event driven (`changes.changed`, at most
 * once a second from the brain) and coalesced so at most one status read is in flight.
 */
export class ChangesSource {
  private state: SourceState = { files: [], loading: true, partial: true, capped: false };
  private listeners = new Set<() => void>();
  private users = 0;
  private full = 0;
  private inflight = false;
  private again = false;
  private abort?: AbortController;
  private off?: () => void;
  constructor(
    private readonly peer: ChatPeer,
    readonly target: ChangesTarget,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private patch(next: Partial<SourceState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  private params() {
    const { conversationKey, topicId, rootId } = this.target;
    return {
      conversationKey,
      ...(topicId ? { topicId } : {}),
      ...(rootId ? { rootId } : {}),
    };
  }
  /** Reference counted: the header and the sidebar share one watch and one listener. */
  start() {
    if (this.users++ === 0) {
      this.off = this.peer.on("changes.changed", (event) => {
        if (event.reason === "folder") {
          // A folder change without a topic covers every topic of the conversation.
          if (
            event.conversationKey === this.target.conversationKey &&
            (!event.topicId || event.topicId === this.target.topicId)
          ) {
            this.watch();
            this.refresh();
          }
        } else if (sameConversation(event, this.target)) this.refresh();
      });
      this.watch();
      this.refresh();
    }
    return () => {
      if (--this.users > 0) return;
      this.off?.();
      this.off = undefined;
      this.abort?.abort();
      this.again = false;
      void this.peer.call("changes.watch", { ...this.params(), on: false }).catch(() => undefined);
    };
  }
  // Starting the watch can fail for an unknown topic (or a missing folder); status still loads.
  // Watching again after a folder change moves the brain's watch to the new folder.
  private watch() {
    void this.peer.call("changes.watch", { ...this.params(), on: true }).catch(() => undefined);
  }
  /** While any consumer needs the whole list, every page is read. */
  wantAll() {
    this.full++;
    if (this.state.partial && this.users) this.refresh();
    return () => {
      this.full--;
    };
  }
  refresh = () => {
    if (this.inflight) {
      this.again = true;
      return;
    }
    void this.run();
  };
  private async run() {
    this.inflight = true;
    try {
      do {
        this.again = false;
        await this.read();
      } while (this.again && this.users);
    } finally {
      this.inflight = false;
    }
  }
  private async read() {
    const abort = new AbortController();
    this.abort = abort;
    const full = this.full > 0;
    try {
      const first = await this.peer.call(
        "changes.status",
        { ...this.params(), limit: full ? PAGE : 1 },
        { signal: abort.signal, timeoutMs: 30_000 },
      );
      const files = [...first.files];
      let cursor = first.nextCursor;
      let pages = 1;
      while (full && cursor && pages < MAX_PAGES) {
        const page = await this.peer.call(
          "changes.status",
          { ...this.params(), cursor, limit: PAGE },
          { signal: abort.signal, timeoutMs: 30_000 },
        );
        files.push(...page.files);
        cursor = page.nextCursor;
        pages++;
      }
      if (abort.signal.aborted) return;
      this.patch({
        status: { ...first, files },
        // Mapping happens once per read; rows reuse these objects until the next change.
        files: files.map(fromChangeFile),
        loading: false,
        error: undefined,
        partial: !full || !!cursor,
        capped: full && !!cursor,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      this.patch({ loading: false, error: changesErrorKey(error) });
    }
  }
}

/** One source per peer and target, kept while any component holds it. */
const sources = new WeakMap<ChatPeer, Map<string, ChangesSource>>();
export function useChangesSource(
  peer: ChatPeer,
  target: ChangesTarget | undefined,
  active: boolean,
) {
  const key = target ? JSON.stringify([target.conversationKey, target.topicId, target.rootId]) : "";
  const source = useMemo(() => {
    if (!key) return undefined;
    const [conversationKey, topicId, rootId] = JSON.parse(key) as (string | null)[];
    const target: ChangesTarget = {
      conversationKey: conversationKey as string,
      ...(topicId ? { topicId } : {}),
      ...(rootId ? { rootId } : {}),
    };
    let map = sources.get(peer);
    if (!map) {
      map = new Map();
      sources.set(peer, map);
    }
    let value = map.get(key);
    if (!value) {
      value = new ChangesSource(peer, target);
      map.set(key, value);
      // A conversation list is small; keep only recent folders so the map cannot grow forever.
      if (map.size > 32) map.delete(map.keys().next().value as string);
    }
    return value;
  }, [peer, key]);
  useEffect(() => (source && active ? source.start() : undefined), [source, active]);
  const empty = useMemo(
    () => ({ files: [], loading: !!source, partial: true, capped: false }),
    [source],
  );
  const snapshot = source?.getSnapshot ?? (() => empty);
  const state = useSyncExternalStore(source?.subscribe ?? noopSubscribe, snapshot, snapshot);
  return { source, state };
}
const noopSubscribe = () => () => {};

/** "This turn" lists per run, shared by reply cards; refreshed when that run's turn is recorded. */
interface TurnEntry {
  data?: ChangesTurn;
  error?: boolean;
  loading: boolean;
}
const pending: TurnEntry = { loading: true };
class TurnCache {
  private entries = new Map<string, TurnEntry>();
  private reads = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  constructor(private readonly peer: ChatPeer) {
    // Lives as long as the peer; a disposed peer drops its own listeners.
    peer.on("changes.changed", (event) => {
      if (event.reason === "turn" && event.runId && this.entries.has(event.runId))
        void this.load(event.runId);
    });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  peek(runId: string) {
    return this.entries.get(runId) ?? pending;
  }
  ensure(runId: string) {
    if (this.entries.has(runId)) return;
    this.entries.set(runId, pending);
    if (this.entries.size > 300) this.entries.delete(this.entries.keys().next().value as string);
    void this.load(runId);
  }
  private set(runId: string, entry: TurnEntry) {
    this.entries.set(runId, entry);
    for (const listener of this.listeners) listener();
  }
  refresh(runId: string) {
    void this.load(runId);
  }
  private async load(runId: string) {
    this.reads.get(runId)?.abort();
    const controller = new AbortController();
    this.reads.set(runId, controller);
    const previous = this.entries.get(runId);
    this.set(runId, { ...previous, error: false, loading: !previous?.data });
    try {
      const data = await this.peer.call(
        "changes.turn",
        { runId },
        { signal: controller.signal, timeoutMs: 30000 },
      );
      if (!controller.signal.aborted) this.set(runId, { data, loading: false });
    } catch {
      if (!controller.signal.aborted)
        this.set(runId, { ...this.entries.get(runId), error: true, loading: false });
    } finally {
      if (this.reads.get(runId) === controller) this.reads.delete(runId);
    }
  }
}
const turnCaches = new WeakMap<ChatPeer, TurnCache>();
function turnCache(peer: ChatPeer) {
  let cache = turnCaches.get(peer);
  if (!cache) {
    cache = new TurnCache(peer);
    turnCaches.set(peer, cache);
  }
  return cache;
}
const idle: TurnEntry = { loading: false };
export function useRunTurn(peer: ChatPeer | undefined, runId: string | undefined) {
  const cache = peer ? turnCache(peer) : undefined;
  useEffect(() => {
    if (cache && runId) cache.ensure(runId);
  }, [cache, runId]);
  const snapshot = () => (cache && runId ? cache.peek(runId) : idle);
  const state = useSyncExternalStore(cache?.subscribe ?? noopSubscribe, snapshot, snapshot);
  const retry = useCallback(() => {
    if (cache && runId) cache.refresh(runId);
  }, [cache, runId]);
  return { ...state, retry };
}
