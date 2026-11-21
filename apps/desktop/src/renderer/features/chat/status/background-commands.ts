import type { ChatPeer } from "@pibot/client-core";
import type { BackgroundCommand } from "@pibot/protocol";
import { useMemo, useSyncExternalStore } from "react";

type Rows = ReadonlyMap<string, BackgroundCommand>;
const empty: Rows = new Map();
// Some providers reuse tool-call ids across turns; the run id makes the step unique.
const rowKey = (runId: string, toolCallId: string) => `${runId}\n${toolCallId}`;

/**
 * One Bot's background commands for the chat lines under their run_command steps. Shared
 * per (peer, Bot) so many tool rows cost one list call and one event subscription; it subscribes
 * while any row is mounted and drops the subscription with the last one.
 */
class BackgroundStore {
  private rows: Rows = empty;
  /** Rows received as events win over an older list response that arrives later. */
  private readonly fromEvents = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private off?: () => void;
  private offStatus?: () => void;
  private generation = 0;
  private readVersion = 0;
  private reading?: AbortController;
  constructor(
    private readonly peer: ChatPeer,
    private readonly botId: string,
    private readonly conversationId?: string,
  ) {}
  getSnapshot = () => this.rows;
  accept(row: BackgroundCommand) {
    if (
      row.botId === this.botId &&
      (!this.conversationId || row.conversationId === this.conversationId)
    )
      this.set([row], true);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  };
  private set(rows: BackgroundCommand[], fromEvent: boolean) {
    const next = new Map(this.rows);
    for (const row of rows) {
      if (!fromEvent && this.fromEvents.has(row.id)) continue;
      if (fromEvent) this.fromEvents.add(row.id);
      next.set(rowKey(row.runId, row.toolCallId), row);
    }
    while (next.size > 200) next.delete(next.keys().next().value as string);
    this.rows = next;
    for (const listener of this.listeners) listener();
  }
  private start() {
    ++this.generation;
    this.off = this.peer.on("backgroundCommands.changed", (row) => {
      if (
        row.botId === this.botId &&
        (!this.conversationId || row.conversationId === this.conversationId)
      )
        this.set([row], true);
    });
    this.offStatus = this.peer.on("chat.status", (event) => {
      if (event.botId === this.botId) this.reload();
    });
    this.reload();
  }
  private reload() {
    const generation = this.generation;
    const readVersion = ++this.readVersion;
    this.reading?.abort();
    this.reading = new AbortController();
    this.fromEvents.clear();
    this.peer
      .call(
        "backgroundCommands.list",
        {
          botId: this.botId,
          limit: 50,
          ...(this.conversationId ? { conversationId: this.conversationId } : {}),
        },
        { signal: this.reading.signal, timeoutMs: 20_000 },
      )
      .then(
        (rows) => {
          if (generation === this.generation && readVersion === this.readVersion)
            this.set(rows, false);
        },
        () => {
          // The line is a side view; without the list only live events show a status.
        },
      );
  }
  private stop() {
    this.generation++;
    this.reading?.abort();
    this.reading = undefined;
    this.off?.();
    this.offStatus?.();
    this.offStatus = undefined;
    this.off = undefined;
    this.rows = empty;
    this.fromEvents.clear();
  }
}

const stores = new WeakMap<ChatPeer, Map<string, BackgroundStore>>();
/** Acknowledged actions also refresh shared views if their event was lost during reconnect. */
export function acceptBackgroundCommand(peer: ChatPeer, row: BackgroundCommand) {
  for (const store of stores.get(peer)?.values() ?? []) store.accept(row);
}
function storeFor(peer: ChatPeer, botId: string, conversationId?: string) {
  const key = `${botId}:${conversationId ?? ""}`;
  let byBot = stores.get(peer);
  if (!byBot) {
    byBot = new Map();
    stores.set(peer, byBot);
  }
  let store = byBot.get(key);
  if (!store) {
    store = new BackgroundStore(peer, botId, conversationId);
    byBot.set(key, store);
  }
  return store;
}

const noopSubscribe = () => () => {};
const emptySnapshot = () => empty;

/** The background command started by this tool call, if any. */
export function useBackgroundRows(
  peer: ChatPeer | null | undefined,
  botId: string,
  enabled = true,
  conversationId?: string,
) {
  const store = useMemo(
    () => (peer && enabled ? storeFor(peer, botId, conversationId) : undefined),
    [peer, botId, enabled, conversationId],
  );
  const rows = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? emptySnapshot,
    store?.getSnapshot ?? emptySnapshot,
  );
  return rows;
}

export function useBackgroundCommand(
  peer: ChatPeer | null | undefined,
  botId: string,
  runId: string,
  toolCallId: string,
  enabled: boolean,
) {
  return useBackgroundRows(peer, botId, enabled).get(rowKey(runId, toolCallId));
}
