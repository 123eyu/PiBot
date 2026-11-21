import { createRequire } from "node:module";
import { type NetworkProxy, proxyAgent } from "@pibot/execution";
import {
  type BinaryTransport,
  type ConnectProgress,
  connectRelay,
  networkErrorClass,
  observeConnectSocket,
  type RoomTicket,
  type SocketConstructor,
  type SocketEvent,
  type SocketLike,
} from "@pibot/link";

// undici loads on the first relay socket, not while the brain starts.
let undiciModule: typeof import("undici") | undefined;
const undici = () =>
  (undiciModule ??= createRequire(import.meta.url)("undici") as typeof import("undici"));

export interface LinkNetwork {
  WebSocket?: SocketConstructor;
  fetch?: typeof globalThis.fetch;
  proxy?: () => NetworkProxy | undefined;
}
export const roomUrl = (base: string, ticket: RoomTicket, role: "desktop" | "phone") =>
  `${base}/room/${ticket.roomId}?credential=${ticket.credential}&period=${ticket.period}&role=${role}`;

// On a lossy, high-latency path (measured on a Windows desktop: ~270 ms RTT to the relay, TCP+TLS
// often 6-16 s) undici's default 10 s connect timeout and a 10 s open deadline failed most attempts.
const RELAY_OPEN_MS = 20_000;
/**
 * HTTP/1.1 only: with h2 negotiated, undici waits for the server's SETTINGS before sending an
 * RFC 8441 extended CONNECT, an extra round trip that on the same path opened 1 of 6 rooms
 * versus 3 of 6 over HTTP/1.1. The relay socket carries one stream, so h2 gains nothing.
 */
export function relayDispatcher(
  proxy: NetworkProxy | undefined,
  observe?: { progress: ConnectProgress; socket(socket: { destroy(): void }): void },
) {
  if (proxy) return proxyAgent(proxy);
  const { Agent, buildConnector } = undici();
  if (!observe) return new Agent({ allowH2: false, connect: { timeout: RELAY_OPEN_MS } });
  const { progress } = observe;
  // Same connector undici builds itself, observed so a failed open names its step, and its raw
  // socket kept: after the upgrade the WebSocket owns it and destroying the Agent no longer
  // reaches it, so a retired socket on a dead path can only be cut here (runner links).
  const connector = buildConnector({ timeout: RELAY_OPEN_MS, allowH2: false });
  return new Agent({
    allowH2: false,
    connect(options, callback) {
      // undici's connector returns its socket although its type says void.
      const socket: unknown = (connector as (...args: Parameters<typeof connector>) => unknown)(
        options,
        (...args) => {
          if (args[0]) progress.error ??= networkErrorClass(args[0]);
          callback(...args);
        },
      );
      if (socket && typeof socket === "object" && "once" in socket && "destroy" in socket) {
        observeConnectSocket(
          socket as unknown as Parameters<typeof observeConnectSocket>[0],
          options.protocol === "https:",
          progress,
        );
        observe.socket(socket as { destroy(): void });
      }
    },
  });
}

/**
 * One socket generation owns one handshake/Peer; reconnects belong to the remote lifecycle.
 * `retryUntilOpen` keeps retrying failed opens (link backoff) until `signal` ends, for callers
 * like pairing that have no lifecycle of their own; once open, a drop still ends the room.
 */
export async function openRoom(
  network: LinkNetwork,
  base: string,
  ticket: RoomTicket,
  role: "desktop" | "phone",
  signal: AbortSignal,
  onPhase?: (phase: "socket_open" | "waiting_presence" | "handshake" | "closed") => void,
  options: { retryUntilOpen?: boolean; heartbeatMs?: number } = {},
) {
  const lifetime = new AbortController();
  // Network implementation is unused during brain registration and first-screen reads.
  const { WebSocket: NetworkSocket } = undici();
  const connection = new AbortController();
  const combined = AbortSignal.any([signal, lifetime.signal]);
  // Retried opens each own a dispatcher; close drains all of them, not only the latest.
  const releases: Promise<void>[] = [];
  let opened = false;
  let online = false;
  // Diagnostics only: why the opened room ended, as a fixed code (first cause wins).
  let ended: string | undefined;
  const changes = new Set<() => void>();
  const changed = () => {
    for (const fn of changes) fn();
  };
  const Native = network.WebSocket;
  const Socket: SocketConstructor = class implements SocketLike {
    private readonly inner: SocketLike;
    constructor(url: string) {
      const proxy = network.proxy?.();
      const dispatcher = Native ? undefined : relayDispatcher(proxy);
      try {
        this.inner = Native ? new Native(url) : new NetworkSocket(url, { dispatcher });
      } catch (error) {
        const pending = dispatcher?.destroy() ?? Promise.resolve();
        void pending.catch(() => {});
        releases.push(pending);
        throw error;
      }
      const release = new Promise<void>((resolve, reject) => {
        this.inner.addEventListener("close", () => {
          if (dispatcher) void dispatcher.destroy().then(resolve, reject);
          else resolve();
        });
      });
      void release.catch(() => {});
      releases.push(release);
    }
    get readyState() {
      return this.inner.readyState;
    }
    get bufferedAmount() {
      return this.inner.bufferedAmount;
    }
    get binaryType() {
      return this.inner.binaryType;
    }
    set binaryType(value: string) {
      this.inner.binaryType = value;
    }
    send(data: ArrayBuffer | string) {
      this.inner.send(data);
    }
    close(code?: number, reason?: string) {
      this.inner.close(code, reason);
    }
    addEventListener(type: string, fn: (event: SocketEvent) => void) {
      this.inner.addEventListener(type, fn);
    }
    removeEventListener(type: string, fn: (event: SocketEvent) => void) {
      this.inner.removeEventListener(type, fn);
    }
  };
  let client: ReturnType<typeof connectRelay> | undefined;
  let rejectOpen: (error: Error) => void = () => {};
  const stop = () => {
    connection.abort();
    rejectOpen(new Error("remote_socket_closed"));
    changed();
    // link's callback may run during construction; finish stop after client assignment.
    queueMicrotask(() => client?.stop());
  };
  const abort = () => stop();
  combined.addEventListener("abort", abort, { once: true });
  const close = async () => {
    onPhase?.("closed");
    lifetime.abort();
    client?.stop();
    combined.removeEventListener("abort", abort);
    changes.clear();
    await Promise.all(releases);
  };
  try {
    const transport = await new Promise<BinaryTransport>((resolve, reject) => {
      rejectOpen = reject;
      client = connectRelay({
        WebSocket: Socket,
        url: () => roomUrl(base, ticket, role),
        signal: combined,
        connectTimeoutMs: RELAY_OPEN_MS,
        ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
        onConnect(wire, closed) {
          opened = true;
          onPhase?.("socket_open");
          closed.addEventListener("abort", stop, { once: true });
          resolve(wire);
        },
        onPresence(value) {
          if (online && !value) ended ??= "peer_left";
          online = value;
          changed();
        },
        onClosed({ reason, opened }) {
          if (opened) ended ??= `relay_${reason}`;
        },
        onState(state) {
          if (state === "offline" && (opened || !options.retryUntilOpen)) stop();
        },
        onError() {
          if (opened || !options.retryUntilOpen) stop();
        },
      });
      if (combined.aborted) stop();
    });
    const waitPresence = async () => {
      if (online) return;
      onPhase?.("waiting_presence");
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          if (!online && !connection.signal.aborted) return;
          changes.delete(done);
          if (connection.signal.aborted) reject(new Error("remote_socket_closed"));
          else resolve();
        };
        changes.add(done);
        done();
      });
    };
    /** Calls `fn` with the phone's relay presence now and on every change; returns unsubscribe. */
    const watchPresence = (fn: (online: boolean) => void) => {
      const notify = () => fn(online);
      changes.add(notify);
      notify();
      return () => changes.delete(notify);
    };
    return {
      transport,
      signal: connection.signal,
      waitPresence,
      watchPresence,
      close,
      reason: () => (connection.signal.aborted ? (ended ?? "relay_closed") : undefined),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
