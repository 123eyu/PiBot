import type { RunReceipt } from "@pibot/protocol";
import type { Peer } from "@pibot/renderer-kit";
import { useCallback, useEffect, useSyncExternalStore } from "react";

interface Entry {
  data?: RunReceipt;
  error?: boolean;
  loading: boolean;
}
const pending: Entry = { loading: true };
const idle: Entry = { loading: false };
const ENTRIES = 300;

/**
 * Receipts per run, shared by every place that shows one (reply, routine run, task detail).
 * Read once per run; re-read only when a late record for that run arrives (file changes, delivery
 * evidence, a child task or the run itself settling).
 */
class ReceiptCache {
  private readonly entries = new Map<string, Entry>();
  private readonly reads = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly peer: Peer) {
    // Lives as long as the peer; a disposed peer drops its own listeners.
    peer.on("changes.changed", (event) => {
      if (event.runId) this.reload(event.runId);
    });
    peer.on("chat.done", (event) => this.reload(event.runId));
    peer.on("chat.error", (event) => this.reload(event.runId));
    peer.on("execution.task.changed", (task) => this.reload(task.parentRunId));
    peer.on("delivery.evidence.changed", (event) => {
      for (const [runId, entry] of this.entries)
        if (entry.data?.conversationId === event.conversationId) this.reload(runId);
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
    if (this.entries.size > ENTRIES) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      this.reads.get(oldest)?.abort();
    }
    void this.load(runId);
  }
  reload(runId: string) {
    if (this.entries.has(runId)) void this.load(runId);
  }
  private set(runId: string, entry: Entry) {
    this.entries.set(runId, entry);
    for (const listener of this.listeners) listener();
  }
  private async load(runId: string) {
    this.reads.get(runId)?.abort();
    const controller = new AbortController();
    this.reads.set(runId, controller);
    const previous = this.entries.get(runId);
    this.set(runId, { ...previous, error: false, loading: !previous?.data });
    try {
      const data = await this.peer.call(
        "runs.receipt",
        { runId },
        { signal: controller.signal, timeoutMs: 30_000 },
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
const caches = new WeakMap<Peer, ReceiptCache>();
function receiptCache(peer: Peer) {
  let cache = caches.get(peer);
  if (!cache) {
    cache = new ReceiptCache(peer);
    caches.set(peer, cache);
  }
  return cache;
}
const noopSubscribe = () => () => {};

export function useRunReceipt(peer: Peer | null, runId: string | undefined) {
  const cache = peer ? receiptCache(peer) : undefined;
  useEffect(() => {
    if (cache && runId) cache.ensure(runId);
  }, [cache, runId]);
  const snapshot = () => (cache && runId ? cache.peek(runId) : idle);
  const state = useSyncExternalStore(cache?.subscribe ?? noopSubscribe, snapshot, snapshot);
  const retry = useCallback(() => {
    if (cache && runId) cache.reload(runId);
  }, [cache, runId]);
  return { ...state, retry };
}
