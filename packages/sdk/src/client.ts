import {
  createPeer,
  Events,
  type KernelEventPayloads,
  type KernelMethodParams,
  type KernelMethodResults,
  Methods,
  type Peer,
  type Port,
} from "@pibot/protocol";
import { z } from "zod";
import { createRunEventStream, type RunEventStreamOptions } from "./run-event-stream.ts";

const TimeoutSchema = z.number().int().positive().max(2_147_483_647);

function assertRunEventPage(
  runId: string,
  afterSeq: number,
  page: KernelMethodResults["runs.events"],
) {
  let cursor = afterSeq;
  let conversationId: string | undefined;
  for (const event of page.events) {
    if (
      event.runId !== runId ||
      event.seq <= cursor ||
      (conversationId !== undefined && event.conversationId !== conversationId)
    )
      throw new TypeError("Invalid run event page");
    cursor = event.seq;
    conversationId = event.conversationId;
  }
  if (page.nextSeq !== cursor) throw new TypeError("Invalid run event cursor");
  return page;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ProductPeer = Peer<typeof Methods, typeof Events>;

export interface PiBotClient {
  listBots(
    params?: KernelMethodParams["bots.list"],
    options?: CallOptions,
  ): Promise<KernelMethodResults["bots.list"]>;
  sendMessage(
    params: KernelMethodParams["chat.send"],
    options?: CallOptions,
  ): Promise<KernelMethodResults["chat.send"]>;
  listRunEvents(
    params: KernelMethodParams["runs.events"],
    options?: CallOptions,
  ): Promise<KernelMethodResults["runs.events"]>;
  streamRunEvents(
    options: RunEventStreamOptions,
  ): AsyncIterable<KernelMethodResults["runs.events"]["events"][number]>;
  listPendingApprovals(
    params?: KernelMethodParams["approvals.pending"],
    options?: CallOptions,
  ): Promise<KernelMethodResults["approvals.pending"]>;
  resolveApproval(
    params: KernelMethodParams["approvals.resolve"],
    options?: CallOptions,
  ): Promise<KernelMethodResults["approvals.resolve"]>;
  onApprovalRequested(
    listener: (approval: KernelEventPayloads["approval.requested"]) => void,
  ): () => void;
  onApprovalResolved(
    listener: (approval: KernelEventPayloads["approval.resolved"]) => void,
  ): () => void;
  dispose(): void;
}

function createClient(peer: ProductPeer, ownsPeer: boolean): PiBotClient {
  const lifetime = new AbortController();
  const subscriptions = new Set<() => void>();
  let disposed = false;

  function signal(options?: CallOptions): AbortSignal {
    if (disposed) throw new DOMException("SDK client disposed", "AbortError");
    return options?.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
  }

  function callOptions(options?: CallOptions) {
    const timeoutMs =
      options?.timeoutMs === undefined ? undefined : TimeoutSchema.parse(options.timeoutMs);
    return {
      signal: signal(options),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }

  function trackSubscription(unsubscribePeer: () => void) {
    if (disposed) throw new DOMException("SDK client disposed", "AbortError");
    let active = true;
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      subscriptions.delete(unsubscribe);
      unsubscribePeer();
    };
    subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  const client: PiBotClient = {
    async listBots(params = {}, options) {
      const value = await peer.call(
        "bots.list",
        Methods["bots.list"].params.parse(params),
        callOptions(options),
      );
      return Methods["bots.list"].result.parse(value);
    },
    async sendMessage(params, options) {
      const value = await peer.call(
        "chat.send",
        Methods["chat.send"].params.parse(params),
        callOptions(options),
      );
      return Methods["chat.send"].result.parse(value);
    },
    async listRunEvents(params, options) {
      const input = Methods["runs.events"].params.parse(params);
      const value = await peer.call("runs.events", input, callOptions(options));
      return assertRunEventPage(
        input.runId,
        input.afterSeq,
        Methods["runs.events"].result.parse(value),
      );
    },
    streamRunEvents(options) {
      return createRunEventStream(
        (params, call) => client.listRunEvents(params, call),
        options,
        lifetime.signal,
      );
    },
    async listPendingApprovals(params = {}, options) {
      const value = await peer.call(
        "approvals.pending",
        Methods["approvals.pending"].params.parse(params),
        callOptions(options),
      );
      return Methods["approvals.pending"].result.parse(value);
    },
    async resolveApproval(params, options) {
      const value = await peer.call(
        "approvals.resolve",
        Methods["approvals.resolve"].params.parse(params),
        callOptions(options),
      );
      return Methods["approvals.resolve"].result.parse(value);
    },
    onApprovalRequested(listener) {
      if (disposed) throw new DOMException("SDK client disposed", "AbortError");
      return trackSubscription(
        peer.on("approval.requested", (payload) =>
          listener(Events["approval.requested"].parse(payload)),
        ),
      );
    },
    onApprovalResolved(listener) {
      if (disposed) throw new DOMException("SDK client disposed", "AbortError");
      return trackSubscription(
        peer.on("approval.resolved", (payload) =>
          listener(Events["approval.resolved"].parse(payload)),
        ),
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort(new DOMException("SDK client disposed", "AbortError"));
      for (const unsubscribe of [...subscriptions]) unsubscribe();
      if (ownsPeer) peer.dispose();
    },
  };
  return client;
}

/** Creates and owns a product Peer over an already connected local or authenticated link Port. */
export function createPiBotClient(port: Port, options: { timeoutMs?: number } = {}): PiBotClient {
  const timeoutMs =
    options.timeoutMs === undefined ? undefined : TimeoutSchema.parse(options.timeoutMs);
  const peer = createPeer(port, {
    methods: Methods,
    events: Events,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return createClient(peer, true);
}

/** Wraps an existing Peer (for example apps/cli headless) without taking ownership of it. */
export function createPiBotClientFromPeer(peer: ProductPeer): PiBotClient {
  return createClient(peer, false);
}
