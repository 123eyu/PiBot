import type { ChatPeer } from "@pibot/client-core";

/** Peer has no request cancellation; release the UI wait and ignore the outstanding response. */
async function waitForRpc<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      call().then(resolve, reject);
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function openToolResource(
  peer: ChatPeer,
  resource: { kind: "file"; botId: string; runId: string; toolCallId: string },
  signal: AbortSignal,
) {
  const { botId, runId, toolCallId } = resource;
  // Display summaries are opaque; only an audited write fact supplies an opening path.
  // Bound legacy pagination until a targeted run/tool lookup is available in the protocol.
  let before: string | undefined;
  for (let page = 0; page < 25; page++) {
    const entries = await waitForRpc(
      () =>
        peer.call("audit.list", {
          botId,
          kind: "file.written",
          limit: 200,
          ...(before ? { before } : {}),
        }),
      signal,
    );
    signal.throwIfAborted();
    const path = entries.find(
      (entry) => entry.runId === runId && entry.detail.toolCallId === toolCallId,
    )?.detail.path;
    if (path) {
      await waitForRpc(() => peer.call("files.open", { botId, path }), signal);
      return;
    }
    const next = entries.length === 200 ? entries.at(-1)?.id : undefined;
    if (!next || next === before) break;
    before = next;
  }
  throw new Error("No audited write path within lookup limit");
}
