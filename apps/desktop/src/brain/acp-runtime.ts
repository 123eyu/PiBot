import {
  type AcpFolderStaging,
  type AcpRpcMethods,
  type AcpRpcPort,
  type AcpRuntimePort,
  createAcpRuntime,
} from "@pibot/acp";
import {
  type AcpLifecycleEvent,
  createPeer,
  Events,
  Methods,
  type Peer,
  type Port,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";

export interface DesktopAcpRuntime {
  peer: Peer<typeof Methods, typeof Events>;
  runtime: AcpRuntimePort;
  lifetime: AbortController;
  work: Set<Promise<unknown>>;
  runs: Set<string>;
  uncertain(): boolean;
}

/** Own dispatched receipts independently of SDK cancellation and presentation. */
export function createDesktopAcpRuntime(
  loopback: Port,
  folders: AcpFolderStaging,
  emit: (event: AcpLifecycleEvent) => void,
): DesktopAcpRuntime {
  const peer = createPeer(loopback, { methods: Methods, events: Events });
  const lifetime = new AbortController();
  const work = new Set<Promise<unknown>>();
  const tracked = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = action();
    work.add(pending);
    void pending.finally(() => work.delete(pending)).catch(() => {});
    return pending;
  };
  let uncertain = false;
  const rpc: AcpRpcPort = {
    on: peer.on.bind(peer),
    call: ((method: keyof AcpRpcMethods, params: unknown, options?: { signal: AbortSignal }) => {
      options?.signal.throwIfAborted();
      // A dispatched mutation must settle at the real receipt, not a cancelled local wait.
      return peer.call(method, params as never, { timeoutMs: 30_000 }).catch((error) => {
        if (
          error instanceof RpcError &&
          (error.code === RpcErrorCodes.timeout || error.code === RpcErrorCodes.closed)
        )
          uncertain = true;
        throw error;
      });
    }) as AcpRpcPort["call"],
  };
  const runtime = createAcpRuntime({
    rpc,
    folders,
    ready: async (signal) => signal.throwIfAborted(),
    timeoutMs: 600_000,
  });
  const original = { ...runtime };
  const bounded = (signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal]);
  runtime.bots = (signal) => tracked(() => original.bots(bounded(signal)));
  runtime.settings = (signal) => tracked(() => original.settings(bounded(signal)));
  runtime.models = (signal) => tracked(() => original.models(bounded(signal)));
  runtime.rebindTopic = (input, signal) =>
    tracked(() => original.rebindTopic(input, bounded(signal)));
  runtime.providers = (signal) => tracked(() => original.providers(bounded(signal)));
  runtime.setBotModel = (input, signal) =>
    tracked(() => original.setBotModel(input, bounded(signal)));
  const { setBotThinking, setDefaultModel } = original;
  if (setBotThinking)
    runtime.setBotThinking = (input, signal) =>
      tracked(() => setBotThinking(input, bounded(signal)));
  if (setDefaultModel)
    runtime.setDefaultModel = (input, signal) =>
      tracked(() => setDefaultModel(input, bounded(signal)));
  runtime.previewMcp = (servers, signal) =>
    tracked(() => original.previewMcp(servers, bounded(signal)));
  runtime.importMcp = (preview, signal) =>
    tracked(() => original.importMcp(preview, bounded(signal)));
  runtime.cancelMcpPreview = (id, _signal) =>
    tracked(() => original.cancelMcpPreview(id, AbortSignal.timeout(5_000)));
  const runs = new Set<string>();
  // A run that reported done/error owns no session any more, so it owes no abort. Keeping its id
  // made a detached client ask to stop its own finished run; that ask came back busy and used to
  // stop the whole brain. Terminal events are the only end-of-run signal here.
  const forget = runtime.onEvent((event) => {
    if (event.method === "chat.done" || event.method === "chat.error")
      runs.delete(event.payload.runId);
  });
  if (lifetime.signal.aborted) forget();
  else lifetime.signal.addEventListener("abort", forget, { once: true });
  const sendPrompt = runtime.sendPrompt;
  runtime.sendPrompt = (input, signal) =>
    tracked(async () => {
      if (runs.size >= 1024) throw new Error("acp_run_capacity");
      const receipt = await sendPrompt(input, bounded(signal));
      runs.add(receipt.runId);
      return receipt;
    });
  const abort = runtime.abort;
  runtime.abort = async (runId, signal) => {
    await abort(runId, signal);
    runs.delete(runId);
  };
  const createTopic = runtime.createTopic;
  runtime.createTopic = (input, signal) =>
    tracked(async () => {
      const topic = await createTopic(input, bounded(signal));
      emit({
        kind: "acp.session.new",
        botId: input.botId,
        topicId: topic.topicId,
        folders: [input.cwd, ...input.additionalDirectories],
      });
      return topic;
    });
  const attachTopic = runtime.attachTopic;
  runtime.attachTopic = (input, signal) =>
    tracked(async () => {
      const topic = await attachTopic(input, bounded(signal));
      // Continuing a person's topic is audited like opening one, but with its own kind so the
      // log shows the client did not create it.
      emit({
        kind: "acp.session.attach",
        botId: input.botId,
        topicId: topic.topicId,
        folders: [input.cwd],
      });
      return topic;
    });

  return { peer, runtime, lifetime, work, runs, uncertain: () => uncertain };
}

/** A batch is one output frame but can settle several independently reserved requests. */
export function releaseAcpResponseReservations(
  state: { inflight: Map<string, number>; requestBytes: number },
  frame: unknown,
): void {
  for (const response of Array.isArray(frame) ? frame : [frame]) {
    if (!response || typeof response !== "object" || !("id" in response) || "method" in response)
      continue;
    const key = JSON.stringify(response.id);
    state.requestBytes -= state.inflight.get(key) ?? 0;
    state.inflight.delete(key);
  }
}
