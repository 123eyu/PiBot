import type { Message, MethodParams } from "@pibot/protocol";
import { appendReplyDelta } from "../chat/reply-delta.ts";
import type { ChatPeer } from "../chat/types.ts";
import { append, confirmAppend } from "./additions.ts";
import { start } from "./events.ts";
import { history, more, refresh } from "./history.ts";
import { send } from "./send.ts";
import type { GroupSessionCache } from "./session-cache.ts";
import type { Delta, GroupTarget, Snapshot } from "./types.ts";

/** Internal state shared by operations; callers use the public controller facade. */
export class GroupSession {
  state: Snapshot = {
    messages: [],
    loading: true,
    error: false,
    hasMore: false,
    paging: false,
    refreshing: false,
    sending: false,
    confirmed: false,
  };

  listeners = new Set<() => void>();

  lifetime = new AbortController();

  off: (() => void)[] = [];

  timer?: ReturnType<typeof setTimeout>;

  deltaTimer?: ReturnType<typeof setTimeout>;

  active = false;

  reading = false;

  dirty = false;

  deltas: Delta[] = [];

  deltaSize = 0;

  generation = 0;

  terminals = new Map<
    string,
    { botId: string; runId: string; status?: Message["status"]; errorCode?: Message["errorCode"] }
  >();

  cacheVersion?: number;

  uncertainAppend?: MethodParams["groups.appendStatus"];

  constructor(
    readonly peer: ChatPeer,
    readonly target: GroupTarget,
    readonly cache?: GroupSessionCache,
  ) {
    if (target.draftId) {
      this.state = { ...this.state, loading: false, confirmed: true };
      return;
    }
    const preview = cache?.readConversation(peer, target);
    if (preview) this.state = { ...this.state, ...preview, loading: false };
  }

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  publish(patch: Partial<Snapshot>, defer = false) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    if (defer) {
      this.deltaTimer ??= setTimeout(() => {
        this.deltaTimer = undefined;
        this.notify();
      }, 100);
      return;
    }
    clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    this.notify();
  }

  notify() {
    if (!this.active) return;
    for (const listener of this.listeners) listener();
  }

  matches(e: { groupId?: string; threadId?: string; conversationId?: string }) {
    return (
      this.active &&
      e.groupId === this.target.groupId &&
      e.conversationId === this.target.conversationId &&
      e.threadId === this.target.threadId
    );
  }

  apply(messages: Message[], e: Delta) {
    return messages.map((m) =>
      m.id === e.messageId && m.runId === e.runId && m.botId === e.botId && m.status === "streaming"
        ? appendReplyDelta(m, e)
        : m,
    );
  }

  schedule = () => {
    this.dirty = true;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, 250);
  };

  terminal(
    e: { messageId?: string; botId?: string; runId: string | null },
    status?: Message["status"],
    errorCode?: Message["errorCode"],
  ) {
    if (!e.messageId || !e.botId || !e.runId) return;
    const known = this.state.messages.find((message) => message.id === e.messageId);
    if (known && (known.botId !== e.botId || known.runId !== e.runId)) return;
    const previous = this.terminals.get(e.messageId);
    const same = previous?.botId === e.botId && previous.runId === e.runId;
    this.terminals.set(e.messageId, {
      botId: e.botId,
      runId: e.runId,
      status: (same ? previous?.status : undefined) ?? status,
      errorCode: (same ? previous?.errorCode : undefined) ?? errorCode,
    });
    if (status)
      this.publish({
        messages: this.state.messages.map((message) =>
          message.id === e.messageId &&
          message.botId === e.botId &&
          message.runId === e.runId &&
          message.status === "streaming"
            ? { ...message, status, errorCode: errorCode ?? null }
            : message,
        ),
      });
    // Bound repair work independently of the loaded history window.
    if (this.terminals.size > 1000)
      this.terminals.delete(this.terminals.keys().next().value as string);
  }

  remember() {
    if (this.state.confirmed && this.cacheVersion !== undefined)
      this.cache?.writeConversation(
        this.peer,
        this.target,
        this.state.messages,
        this.state.hasMore,
        this.cacheVersion,
      );
  }
  start = start.bind(this);
  history = history.bind(this);
  refresh = refresh.bind(this);
  more = more.bind(this);
  append = append.bind(this);
  confirmAppend = confirmAppend.bind(this);
  send = send.bind(this);
}
