import { type Bot, RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { ClientPeer } from "../rpc/peer.ts";

type BotPeer = Pick<ClientPeer, "call">;

function page(peer: BotPeer, before: string | undefined, signal: AbortSignal, timeoutMs: number) {
  signal.throwIfAborted();
  const request = peer.call("bots.list", { before, limit: 200 }, { timeoutMs, signal });
  // Queued reads can be removed; an accepted remote read still owns its actual settlement.
  return new Promise<Bot[]>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    request.then(
      (bots) => {
        signal.removeEventListener("abort", abort);
        resolve(bots);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function readMainBot(
  peer: BotPeer,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<Bot | undefined> {
  const timeout = new RpcError(RpcErrorCodes.timeout, "Bot lookup timed out");
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
  const active = AbortSignal.any([signal, controller.signal]);
  const cursors = new Set<string>();
  let before: string | undefined;
  try {
    while (true) {
      active.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeout;
      const bots = await page(peer, before, active, remaining);
      active.throwIfAborted();
      if (Date.now() >= deadline) throw timeout;
      const main = bots.find((bot) => bot.isMain);
      if (main) return main;
      if (bots.length < 200) return undefined;
      // Use the last Bot UUID, never a timestamp; reject repeated/cyclic legacy cursors.
      const cursor = bots.at(-1)?.id;
      if (!cursor || cursors.has(cursor)) throw new Error("Bot cursor did not advance");
      cursors.add(cursor);
      before = cursor;
    }
  } finally {
    clearTimeout(timer);
  }
}
