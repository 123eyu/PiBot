import { z } from "zod";
import type { RandomBytes } from "../core/bytes.ts";
import type { EndpointKeys } from "../keys/endpoint.ts";
import { isLanAddress } from "../transport/lan.ts";
import { connectRunnerSocket } from "../transport/runner-direct.ts";
import type { SocketConstructor, SocketLike } from "../transport/socket.ts";

export type PhoneRunnerDiscover = (
  signal: AbortSignal,
  resolved: (value: unknown) => void,
) => Promise<() => void>;
const service = z.object({
  name: z.string(),
  port: z.number().int().min(1).max(65535),
  addresses: z.array(z.string()).max(32),
});
export async function discoverPhoneRunner(options: {
  instance: string;
  token: string;
  discover: PhoneRunnerDiscover;
  WebSocket: SocketConstructor;
  keys: EndpointKeys;
  runner: string;
  signature: string;
  random: RandomBytes;
  signal: AbortSignal;
}) {
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  let off = () => {};
  let socket: SocketLike | undefined;
  let session: Awaited<ReturnType<typeof connectRunnerSocket>> | undefined;
  let pending: Promise<void> | undefined;
  const seen = new Set<string>();
  let resolve!: (s: Awaited<ReturnType<typeof connectRunnerSocket>>) => void;
  let reject!: (e: Error) => void;
  const result = new Promise<Awaited<ReturnType<typeof connectRunnerSocket>>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void result.catch(() => {});
  const abort = () => {
    reject(new Error("phone_lan_closed"));
    socket?.close(1000);
  };
  signal.addEventListener("abort", abort, { once: true });
  const close = async () => {
    stop.abort();
    signal.removeEventListener("abort", abort);
    off();
    await pending;
    await session?.close();
  };
  try {
    off = await options.discover(signal, (value) => {
      const parsed = service.safeParse(value);
      if (!parsed.success || parsed.data.name !== options.instance || pending || signal.aborted)
        return;
      const address = parsed.data.addresses.find((s) => isLanAddress(s) && !seen.has(s));
      if (!address || seen.size >= 16) return;
      seen.add(address);
      pending = (async () => {
        const current = new options.WebSocket(
          `ws://${address.includes(":") ? `[${address}]` : address}:${parsed.data.port}/link/${options.token}`,
        );
        socket = current;
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        try {
          await new Promise<void>((yes, no) => {
            const cleanup = () => {
              current.removeEventListener("open", opened);
              current.removeEventListener("error", failed);
              current.removeEventListener("close", failed);
              deadline.removeEventListener("abort", failed);
            };
            const opened = () => {
              cleanup();
              yes();
            };
            const failed = () => {
              cleanup();
              no(new Error("phone_lan_open_failed"));
            };
            current.addEventListener("open", opened);
            current.addEventListener("error", failed);
            current.addEventListener("close", failed);
            deadline.addEventListener("abort", failed, { once: true });
            if (current.readyState === 1) opened();
            else if (deadline.aborted) failed();
          });
          session = await connectRunnerSocket(current, {
            keys: options.keys,
            publicKey: options.runner,
            role: "responder",
            signal,
            random: options.random,
            authorizationSignature: options.signature,
          });
          session.select();
          await session.activate();
          resolve(session);
        } catch {
          await session?.close();
          current.close(1000);
        }
      })().finally(() => {
        pending = undefined;
      });
    });
    if (signal.aborted) abort();
    const selected = await result;
    off();
    off = () => {};
    return { port: selected.port, signal: selected.signal, path: "lan" as const, close };
  } catch (error) {
    await close();
    throw error;
  }
}
