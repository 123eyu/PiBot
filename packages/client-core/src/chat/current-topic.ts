import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { ChatReadCache } from "./read-cache.ts";
import type { ChatPeer } from "./types.ts";

/** Updated-time ordering includes routine topics; only the current marker is a route. */
export async function readCurrentTopic(
  peer: ChatPeer,
  reads: ChatReadCache,
  botId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const expired = new AbortController();
  const timer = setTimeout(
    () => expired.abort(new RpcError(RpcErrorCodes.timeout, "Current topic lookup timed out")),
    30_000,
  );
  const active = AbortSignal.any([signal, expired.signal]);
  try {
    const check = (
      page: readonly { botId: string | null; kind: string; archivedAt?: string | null }[],
    ) => {
      if (page.some((topic) => topic.botId !== botId || topic.kind !== "dm" || topic.archivedAt))
        throw new Error("Current topic scope mismatch");
    };
    // One indexed answer from brains that know `currentOnly`; a phone paired with an older
    // desktop gets invalidParams there and falls back to paging below.
    try {
      const page = await reads.read(
        `topics-current-only:${botId}`,
        (signal) => peer.call("topics.list", { botId, currentOnly: true, limit: 1 }, { signal }),
        active,
      );
      active.throwIfAborted();
      check(page);
      if (page.some((topic) => !topic.isCurrent)) throw new Error("Current topic scope mismatch");
      return page[0]?.id;
    } catch (error) {
      if (!(error instanceof RpcError && error.code === RpcErrorCodes.invalidParams)) throw error;
    }
    let before: string | undefined;
    const seen = new Set<string>();
    // Match the existing open-current-topic lookup bound, without sidebar writes or prefetch.
    for (let pageNumber = 0; pageNumber < 25; pageNumber++) {
      const page = await reads.read(
        `topics-current:${JSON.stringify([botId, before])}`,
        (signal) => peer.call("topics.list", { botId, before, limit: 200 }, { signal }),
        active,
      );
      active.throwIfAborted();
      check(page);
      const current = page.filter((topic) => topic.isCurrent);
      if (current.length > 1) throw new Error("Ambiguous current topic");
      if (current[0]) return current[0].id;
      const cursor = page.at(-1)?.id;
      if (page.length < 200 || !cursor) return undefined;
      if (seen.has(cursor)) break;
      seen.add(cursor);
      before = cursor;
    }
    throw new Error("Current topic unavailable within lookup bounds");
  } finally {
    clearTimeout(timer);
    expired.abort();
  }
}
