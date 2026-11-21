import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { Peer, View } from "@pibot/renderer-kit";

/** Resolve the current marker before choosing a controller; never rebind a cached live stream. */
export async function openCurrentTopic(
  peer: Peer,
  botId: string,
  signal: AbortSignal,
): Promise<View> {
  const deadline = Date.now() + 30_000;
  const timeout = new RpcError(RpcErrorCodes.timeout, "Current topic lookup timed out");
  const expired = new AbortController();
  const timer = setTimeout(() => expired.abort(timeout), 30_000);
  const active = AbortSignal.any([signal, expired.signal]);
  const read = async <T>(operation: (remaining: number) => Promise<T>) => {
    active.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeout;
    let abort = () => {};
    try {
      return await new Promise<T>((resolve, reject) => {
        abort = () => reject(active.reason);
        active.addEventListener("abort", abort, { once: true });
        operation(remaining).then(resolve, reject);
      });
    } finally {
      active.removeEventListener("abort", abort);
    }
  };
  try {
    await read((timeoutMs) =>
      peer.call("sidebar.open", { conversationKey: `dm:${botId}` }, { timeoutMs }),
    );
    let before: string | undefined;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 25; pageNumber++) {
      const page = await read((timeoutMs) =>
        peer.call("topics.list", { botId, before, limit: 200 }, { timeoutMs }),
      );
      active.throwIfAborted();
      if (page.some((topic) => topic.botId !== botId || topic.kind !== "dm" || topic.archivedAt))
        throw new Error("Current topic scope mismatch");
      const current = page.filter((topic) => topic.isCurrent);
      if (current.length > 1) throw new Error("Ambiguous current topic");
      if (current[0]) return { name: "chat", botId, topicId: current[0].id };
      const cursor = page.at(-1)?.id;
      if (page.length < 200 || !cursor || seen.has(cursor)) break;
      seen.add(cursor);
      before = cursor;
    }
    throw new Error("Current topic unavailable within lookup bounds");
  } finally {
    clearTimeout(timer);
    expired.abort();
  }
}
