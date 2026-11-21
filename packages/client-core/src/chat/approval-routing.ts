import type { Approval } from "@pibot/protocol";
import type { ChatPeer } from "./types.ts";

type Route = Pick<Approval, "runId"> & { conversationId?: string };
const LIMIT = 1000;

/** One display-only index per Peer, shared by cached chats; no new wire fields for older peers. */
export class ChatApprovalRouting {
  private readonly routes = new Map<string, Route>();
  private readonly lifetime = new AbortController();
  private readonly off: () => void;
  private readonly ready: Promise<void>;
  constructor(peer: ChatPeer) {
    this.off = peer.on("approval.requested", (approval) => this.remember(approval));
    this.ready = this.load(peer).catch(() => {
      // A reconnect/read failure leaves identity unknown, never attributed to an arbitrary chat.
      // Chat/tool events and reopening a cached chat still refresh its committed history.
    });
  }
  private remember(approval: Approval) {
    if (this.lifetime.signal.aborted) return;
    this.routes.delete(approval.id);
    this.routes.set(approval.id, {
      runId: approval.runId,
      ...(approval.conversationId ? { conversationId: approval.conversationId } : {}),
    });
    if (this.routes.size > LIMIT) this.routes.delete(this.routes.keys().next().value as string);
  }
  private async load(peer: ChatPeer) {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]);
    let before: string | undefined;
    for (let scanned = 0; scanned < LIMIT; scanned += 200) {
      const page = await peer.call("approvals.pending", { before, limit: 200 }, { signal });
      signal.throwIfAborted();
      for (const approval of page) this.remember(approval);
      if (page.length < 200) return;
      const next = page.at(-1)?.id;
      if (!next || next === before) return;
      before = next;
    }
  }
  async route(id: string): Promise<Route | undefined> {
    if (!this.routes.has(id)) await this.ready;
    return this.routes.get(id);
  }
  dispose() {
    this.lifetime.abort();
    this.off();
    this.routes.clear();
  }
}
