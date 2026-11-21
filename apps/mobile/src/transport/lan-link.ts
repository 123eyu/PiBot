import {
  base64url,
  destroyEndpoint,
  dhPublic,
  encryptedPort,
  endpointKeys,
  establishDirectNoise,
  establishNoise,
  type LinkWire,
  negotiateDirect,
  type RandomBytes,
  type RtcPeerFactory,
  type SocketConstructor,
  type SocketEvent,
  unbase64,
} from "@pibot/link";
import {
  isLanAddress,
  LAN_PROLOGUE,
  lanPathSession,
  lanToken,
  signalingWire,
} from "@pibot/link/lan";
import { lanSocket } from "@pibot/link/lan-socket";
import { z } from "zod";
import { type Credential, sanitizeLanAddresses } from "./credential.ts";
import { reportDirectDiagnostic, reportPathEvent } from "./diagnostics.ts";
import type { LinkConnection } from "./link-port.ts";
import { mobileNetworkHint } from "./network-hint.ts";
import { portConnection } from "./port-connection.ts";
import { reportSocketRetired, retireSocket } from "./retire-socket.ts";

export type LanDiscover = (
  signal: AbortSignal,
  resolved: (value: unknown) => void,
) => Promise<() => void>;
const Service = z.object({
  name: z.string().regex(/^[0-9a-f]{32}$/),
  port: z.number().int().min(1).max(65535),
  addresses: z.array(z.string().max(64)).max(16),
  txt: z.object({ v: z.literal("1") }),
});
interface Options {
  WebSocket: SocketConstructor;
  random: RandomBytes;
  createRtcPeer: RtcPeerFactory;
  discover: LanDiscover;
  discoverEnabled?: boolean;
  /** T4: a relay session's TCP upgrade must remain the selected LAN transport. */
  allowDirect?: boolean;
}
async function openSocket(Socket: SocketConstructor, url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const socket = new Socket(url);
  const wire = lanSocket(socket, signal, (reason) => {
    // A socket that never opened is retired at once and is not worth a warning.
    if (reason === "close_timeout") reportSocketRetired("lan", reason);
    retireSocket(socket, "lan");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        cleanup();
        reject(new Error("lan_socket_closed"));
      };
      const open = (_: SocketEvent) => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        socket.removeEventListener("open", open);
        wire.transport.closed.removeEventListener("abort", stop);
      };
      socket.addEventListener("open", open);
      wire.transport.closed.addEventListener("abort", stop, { once: true });
      if (wire.transport.closed.aborted) stop();
    });
    return wire;
  } catch (error) {
    await wire.close();
    throw error;
  }
}

async function connectAddress(
  options: Options,
  credential: Credential,
  url: string,
  signal: AbortSignal,
): Promise<LinkConnection> {
  const wire = await openSocket(options.WebSocket, url, signal);
  const seed = unbase64(credential.seed, 32);
  const keys = endpointKeys(seed);
  seed.fill(0);
  try {
    const channel = await establishNoise(wire.transport, {
      role: "initiator",
      staticSecret: keys.dhSecret,
      remoteStatic: dhPublic(unbase64(credential.publicKey, 32)),
      random: options.random,
      prologue: LAN_PROLOGUE,
      signal,
      timeoutMs: 5000,
    });
    const port = encryptedPort(channel, wire.transport, { signal });
    const session = await lanPathSession({
      onDiagnostic: reportDirectDiagnostic,
      onEvent: reportPathEvent,
      relay: signalingWire({
        port,
        closed: wire.transport.closed,
        close: async () => {
          port.dispose?.();
          await wire.close();
        },
      }),
      role: "initiator",
      signal,
      reconnect: async () => {
        throw new Error("lan_signaling_closed");
      },
      ...(options.allowDirect === false
        ? {}
        : {
            async direct(
              port: import("@pibot/protocol-base").Port,
              active: AbortSignal,
            ): Promise<LinkWire> {
              const hint = await mobileNetworkHint(active);
              const data = await negotiateDirect({
                failureHint: () => hint,
                onDiagnostic: reportDirectDiagnostic,
                port,
                createPeer: options.createRtcPeer,
                role: "initiator",
                signal: active,
              });
              const seed = unbase64(credential.seed, 32);
              const identity = endpointKeys(seed);
              seed.fill(0);
              try {
                const { channel, transport } = await establishDirectNoise(data, {
                  role: "initiator",
                  staticSecret: identity.dhSecret,
                  remoteStatic: dhPublic(unbase64(credential.publicKey, 32)),
                  random: options.random,
                  signal: active,
                });
                const encrypted = encryptedPort(channel, transport, { signal: active });
                return {
                  port: encrypted,
                  closed: transport.closed,
                  pathKind: data.pathKind,
                  close: async () => {
                    encrypted.dispose?.();
                  },
                };
              } finally {
                destroyEndpoint(identity);
              }
            },
          }),
    });
    const epoch = `link:${base64url(options.random(16))}`;
    const snapshot = () => {
      const path = session.current();
      return portConnection({
        port: path.port,
        path: path.path,
        ...(path.kind ? { pathKind: path.kind } : {}),
        closed: path.closed,
        epoch,
        onKeepalive: () => session.enableKeepalive(),
        close: (reason) => session.close(reason),
      });
    };
    return {
      ...snapshot(),
      lanAddress: url,
      onClose(fn) {
        const abort = () => fn();
        session.closed.addEventListener("abort", abort, { once: true });
        if (session.closed.aborted) abort();
        return () => session.closed.removeEventListener("abort", abort);
      },
      onPath: (fn) => session.onChange(() => fn(snapshot())),
      networkChanged: () => session.networkChanged(),
      pulse: () => session.pulse(),
      setExternalClock: (active: boolean) => session.setExternalClock(active),
      probe: (timeoutMs) => session.probe(timeoutMs),
      endReason: () => session.endReason(),
    };
  } catch (error) {
    await wire.close();
    throw error;
  } finally {
    destroyEndpoint(keys);
  }
}

export async function connectLan(
  options: Options,
  credential: Credential,
  signal: AbortSignal,
  timeoutMs = 25_000,
  preferred: readonly string[] = [],
): Promise<LinkConnection> {
  const lifetime = new AbortController();
  const active = AbortSignal.any([signal, lifetime.signal]);
  const deadline = setTimeout(() => lifetime.abort(), timeoutMs);
  const attempts = new Set<Promise<void>>();
  const queue: { url: string; controller: AbortController }[] = [];
  const controllers = new Set<AbortController>();
  const seen = new Set<string>();
  const key = unbase64(credential.roomKey, 32);
  let selected: LinkConnection | undefined;
  let stop: (() => void) | undefined;
  let finish: (value: LinkConnection) => void;
  let fail: (error: Error) => void;
  let failExhausted: (error: Error) => void;
  const ready = new Promise<LinkConnection>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void ready.catch(() => {});
  const exhausted = new Promise<LinkConnection>((_, reject) => {
    failExhausted = reject;
  });
  void exhausted.catch(() => {});
  const abort = () => fail(new Error("lan_discovery_cancelled"));
  active.addEventListener("abort", abort, { once: true });
  const pump = () => {
    while (!selected && !active.aborted && attempts.size < 2 && queue.length) {
      const item = queue.shift();
      if (!item) break;
      let timer: ReturnType<typeof setTimeout>;
      const task = (async () => {
        // The attempt deadline ends after commit, never becoming a direct session's lifetime.
        timer = setTimeout(() => item.controller.abort(), 15_000);
        try {
          const value = await connectAddress(
            options,
            credential,
            item.url,
            AbortSignal.any([active, item.controller.signal]),
          );
          if (selected || active.aborted) {
            await value.close();
            return;
          }
          selected = value;
          for (const c of controllers) if (c !== item.controller) c.abort();
          finish(value);
        } catch (error) {
          if (error instanceof Error && error.message === "drain_unconfirmed") fail(error);
        } finally {
          clearTimeout(timer);
        }
      })();
      attempts.add(task);
      void task
        .finally(() => {
          attempts.delete(task);
          pump();
          if (!selected && queue.length === 0 && attempts.size === 0)
            failExhausted(new Error("lan_unavailable"));
        })
        .catch(() => fail(new Error("drain_unconfirmed")));
    }
  };
  try {
    for (const url of sanitizeLanAddresses(preferred)) {
      const controller = new AbortController();
      controllers.add(controller);
      queue.push({ url, controller });
    }
    pump();
    // A remembered-only attempt has a finite owner: once every address has failed,
    // do not leave firstConnection waiting on a discovery promise that was never real.
    if (options.discoverEnabled === false) {
      const connection = await Promise.race([ready, exhausted]);
      await Promise.all([...attempts]);
      return connection;
    }
    if (selected) {
      const connection = await ready;
      return connection;
    }
    stop = await options.discover(active, (raw) => {
      if (active.aborted || selected || seen.size >= 32) return;
      const parsed = Service.safeParse(raw);
      if (!parsed.success) return;
      const service = parsed.data;
      for (const address of service.addresses.filter(isLanAddress)) {
        const url = `ws://${address}:${service.port}/link/${lanToken(key, service.name)}`;
        if (seen.has(url) || seen.size >= 32) continue;
        seen.add(url);
        const controller = new AbortController();
        controllers.add(controller);
        queue.push({ url, controller });
      }
      pump();
    });
    if (active.aborted) abort();
    const connection = await ready;
    stop();
    stop = undefined;
    await Promise.all([...attempts]);
    active.throwIfAborted();
    return connection;
  } catch (error) {
    lifetime.abort();
    await Promise.allSettled([...attempts]);
    await selected?.close();
    throw error;
  } finally {
    clearTimeout(deadline);
    stop?.();
    active.removeEventListener("abort", abort);
    key.fill(0);
  }
}
