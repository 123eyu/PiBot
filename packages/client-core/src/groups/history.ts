import { waitRpc } from "../rpc/wait.ts";
import { readGroupWindow } from "./history-window.ts";
import type { GroupSession } from "./session.ts";

export async function history(this: GroupSession, before?: string, parent?: AbortSignal) {
  const signal = AbortSignal.any([
    this.lifetime.signal,
    AbortSignal.timeout(30_000),
    ...(parent ? [parent] : []),
  ]);
  const page = await waitRpc(
    () =>
      this.peer.call(
        this.target.threadId ? "chat.history" : "groups.topics.history",
        {
          groupId: this.target.groupId,
          ...(this.target.threadId
            ? { threadId: this.target.threadId }
            : { topicId: this.target.conversationId }),
          before,
          limit: 50,
        },
        { signal },
      ),
    signal,
  );
  signal.throwIfAborted();
  if (page.some((m) => m.conversationId !== this.target.conversationId))
    throw new Error("Wrong conversation");
  return page;
}

export async function refresh(this: GroupSession) {
  if (!this.active || this.target.draftId) return;
  if (this.reading || this.state.paging) {
    this.dirty = true;
    return;
  }
  this.reading = true;
  this.publish({ refreshing: true });
  this.dirty = false;
  // The DB read already contains some live deltas; do not append them twice to its checkpoint.
  this.deltas = [];
  this.deltaSize = 0;
  const generation = this.generation;
  const cacheVersion = this.cache?.version;
  try {
    const deadline = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]);
    const window = await readGroupWindow(
      (before) => this.history(before, deadline),
      () => this.state.messages,
      this.terminals,
      deadline,
    );
    if (!this.active || generation !== this.generation) return;
    // Tool ends refresh the window; unchanged rows keep their objects so memoized rows do not
    // re-render and re-parse Markdown on every browser step.
    const previous = new Map(this.state.messages.map((m) => [m.id, m]));
    this.publish({
      messages: window.messages.map((m) => {
        const old = previous.get(m.id);
        return old && JSON.stringify(old) === JSON.stringify(m) ? old : m;
      }),
      hasMore: window.hasMore ?? this.state.hasMore,
      loading: false,
      error: false,
      confirmed: true,
    });
    this.cacheVersion = cacheVersion;
    this.remember();
    if (this.deltas.length) this.dirty = true;
  } catch {
    if (generation === this.generation && !this.lifetime.signal.aborted)
      this.publish({ loading: false, error: true });
  } finally {
    if (generation === this.generation) {
      this.reading = false;
      this.publish({ refreshing: false });
      this.deltas = [];
      this.deltaSize = 0;
      if (this.active && this.dirty) this.schedule();
    }
  }
}

export async function more(this: GroupSession, signal?: AbortSignal) {
  if (!this.active || this.reading || this.state.paging || !this.state.hasMore) return;
  this.publish({ paging: true });
  const generation = this.generation;
  try {
    const page = await this.history(this.state.messages[0]?.id, signal);
    signal?.throwIfAborted();
    if (generation !== this.generation) return;
    const ids = new Set(this.state.messages.map((m) => m.id));
    this.publish({
      messages: [...page.filter((m) => !ids.has(m.id)), ...this.state.messages],
      hasMore: page.length === 50,
      error: false,
    });
    this.remember();
  } catch {
    if (generation === this.generation && !this.lifetime.signal.aborted && !signal?.aborted)
      this.publish({ error: true });
  } finally {
    if (generation === this.generation) {
      this.publish({ paging: false });
      if (this.active && this.dirty) this.schedule();
    }
  }
}
