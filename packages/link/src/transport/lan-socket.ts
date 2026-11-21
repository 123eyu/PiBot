import { LinkError, MAX_FRAME } from "../core/bytes.ts";
import type { BinaryTransport } from "./port.ts";
import type { SocketEvent, SocketLike } from "./socket.ts";

/** A bounded, heartbeat-owned LAN socket; it carries only Noise and encrypted signaling. */
export function lanSocket(
  socket: SocketLike,
  signal: AbortSignal,
  /** Host-specific abandonment, only after frames are detached and the close deadline expires. */
  retire?: (reason: "close_timeout" | "never_opened") => void,
) {
  const lifetime = new AbortController();
  const listeners = new Set<(frame: Uint8Array) => void>();
  let seen = Date.now();
  let confirmed = false;
  let ended = false;
  // A socket that never opened has nothing in flight; waiting for its close receipt only delays
  // the winner (a dead LAN hint held a phone's reconnect ~10 s, 2026-11-11).
  let opened = socket.readyState === 1;
  const markOpen = () => {
    opened = true;
  };
  let resolveClosed: () => void;
  const receipt = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const detachFrames = () => {
    clearInterval(timer);
    signal.removeEventListener("abort", stop);
    socket.removeEventListener("message", message);
    socket.removeEventListener("error", stop);
    socket.removeEventListener("open", markOpen);
    listeners.clear();
  };
  const detach = () => {
    detachFrames();
    socket.removeEventListener("close", close);
  };
  const close = () => {
    ended = true;
    lifetime.abort();
    detach();
    resolveClosed();
  };
  const stop = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    detachFrames();
    socket.close(1000);
  };
  const message = (event: SocketEvent) => {
    if (lifetime.signal.aborted) return;
    if (event.data === "pibot:ping") {
      socket.send("pibot:pong");
      seen = Date.now();
      return;
    }
    if (event.data === "pibot:pong") {
      seen = Date.now();
      return;
    }
    const data = event.data;
    const frame =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Uint8Array
          ? data
          : undefined;
    if (!frame?.length || frame.length > (confirmed ? MAX_FRAME : 4200)) return stop();
    seen = Date.now();
    for (const listener of listeners) listener(frame);
  };
  const timer = setInterval(() => {
    if (Date.now() - seen > 30_000) return stop();
    try {
      socket.send("pibot:ping");
    } catch {
      stop();
    }
  }, 10_000);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", markOpen);
  socket.addEventListener("message", message);
  socket.addEventListener("close", close);
  socket.addEventListener("error", stop);
  signal.addEventListener("abort", stop, { once: true });
  const transport: BinaryTransport = {
    kind: "direct",
    closed: lifetime.signal,
    send(frame) {
      if (lifetime.signal.aborted || socket.readyState !== 1) throw new LinkError("lan_closed");
      if (frame.length > MAX_FRAME || socket.bufferedAmount > 2 * MAX_FRAME)
        throw new LinkError("transport_capacity");
      socket.send(frame.slice().buffer);
    },
    subscribe(listener) {
      if (lifetime.signal.aborted) throw new LinkError("lan_closed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: stop,
    confirm() {
      confirmed = true;
    },
    bufferedAmount: () => socket.bufferedAmount,
  };
  if (signal.aborted) stop();
  let closing: Promise<void> | undefined;
  return {
    transport,
    close() {
      closing ??= (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          stop();
          if (ended) return;
          if (!opened && retire) {
            detach();
            retire("never_opened");
            return;
          }
          const confirmed = await Promise.race([
            receipt.then(() => true),
            new Promise<boolean>((resolve) => {
              // A host that can abandon the socket (the phone) stops waiting sooner: a losing LAN
              // branch that opened but never answers held every relay connect for 5 s, because
              // the race returns only after its losers drained. Without `retire` the close must
              // be confirmed, so that host keeps the long wait.
              timeout = setTimeout(() => resolve(false), retire ? 1500 : 5000);
            }),
          ]);
          if (!confirmed) {
            // An injected host may abandon a transport without claiming an OS close receipt.
            if (!retire) throw new LinkError("drain_unconfirmed");
            detach();
            retire("close_timeout");
          }
        } finally {
          clearTimeout(timeout);
          if (ended || retire) detach();
        }
      })().catch((error) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
}
