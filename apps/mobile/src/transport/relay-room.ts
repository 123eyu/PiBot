import {
  type BinaryTransport,
  connectRelay,
  type RoomTicket,
  type SocketConstructor,
  type SocketLike,
} from "@pibot/link";

import { reportLinkEvent } from "./diagnostics.ts";
import { reportSocketRetired, retireSocket } from "./retire-socket.ts";

/** One socket generation per Peer; MobileSession owns reconnects and event recovery. */
export async function openPhoneRoom(
  WebSocket: SocketConstructor,
  relay: string,
  ticket: RoomTicket,
  signal: AbortSignal,
  timeoutMs: number,
  /**
   * How long an open room may wait for the computer. A resume caps it at 5 s so a computer that
   * is gone fails over fast; pairing must wait longer, because the computer opens its pairing
   * room only when "Add phone" is clicked and a slow relay path can take several seconds.
   */
  presenceMs = Math.min(timeoutMs, 5_000),
) {
  signal.throwIfAborted();
  const started = Date.now();
  let openedAt = started;
  const lifetime = new AbortController();
  const active = AbortSignal.any([signal, lifetime.signal]);
  let wire: BinaryTransport | undefined;
  let present = false;
  let delivered = false;
  let resolveReady: (wire: BinaryTransport) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<BinaryTransport>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let closeReason = "relay_closed";
  // Diagnostics only: why an established room ended, as a fixed code (first cause wins).
  let ended: string | undefined;
  const endWith = (reason: string) => {
    ended ??= reason;
    lifetime.abort();
  };
  const abort = () => rejectReady(new Error(closeReason));
  active.addEventListener("abort", abort, { once: true });
  let timer = setTimeout(() => {
    closeReason = wire
      ? present
        ? "remote_session_timeout"
        : "remote_room_empty"
      : "relay_unavailable";
    lifetime.abort();
  }, timeoutMs);
  let socket: SocketLike | undefined;
  let confirmed = false;
  let offClosed = () => {};
  let closedSocket: Promise<void> = Promise.resolve();
  const TrackedSocket = class extends WebSocket {
    constructor(url: string) {
      super(url);
      socket = this;
      closedSocket = new Promise<void>((resolve) => {
        const closed = () => {
          confirmed = true;
          this.removeEventListener("close", closed);
          resolve();
        };
        this.addEventListener("close", closed);
        offClosed = () => this.removeEventListener("close", closed);
      });
    }
  };
  const client = connectRelay({
    WebSocket: TrackedSocket,
    url: () =>
      `${relay}/room/${ticket.roomId}?credential=${ticket.credential}&period=${ticket.period}&role=phone`,
    signal: active,
    onConnect(transport, connection) {
      wire = transport;
      openedAt = Date.now();
      reportLinkEvent("connect_stage", { stage: "socket_open", ms: openedAt - started });
      clearTimeout(timer);
      timer = setTimeout(() => {
        closeReason = "remote_room_empty";
        lifetime.abort();
      }, presenceMs);
      connection.addEventListener("abort", () => lifetime.abort(), { once: true });
      if (connection.aborted) lifetime.abort();
      if (present) {
        delivered = true;
        resolveReady(transport);
      }
    },
    onPresence(online) {
      present = online;
      if (online && wire) {
        reportLinkEvent("connect_stage", { stage: "room_ready", ms: Date.now() - openedAt });
        delivered = true;
        resolveReady(wire);
      } else if (!online && delivered) endWith("peer_left");
    },
    onError() {
      closeReason = "relay_unavailable";
      endWith("relay_error");
    },
    onClosed({ reason, opened, stage }) {
      if (!opened)
        reportLinkEvent("connect_stage_failed", { stage, reason, ms: Date.now() - started });
      if (opened) ended ??= `relay_${reason}`;
    },
    onState(state) {
      if (state === "offline") {
        closeReason = "relay_unavailable";
        endWith("relay_offline");
      }
    },
    connectTimeoutMs: Math.min(timeoutMs, 8_000),
    // Below mobile carrier NAT idle timeouts; the relay answers pings without waking the room.
    heartbeatMs: 15_000,
  });
  let closing: Promise<void> | undefined;
  const close = (reason = "local_close") => {
    ended ??= reason;
    closing ??= (async () => {
      lifetime.abort();
      client.stop();
      wire?.close();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!socket || confirmed || socket.readyState === 3) return;
        const closed = await Promise.race([
          closedSocket.then(() => true),
          new Promise<boolean>((resolve) => {
            // The next attempt waits for this drain. A dead network never confirms the close (the
            // usual reason to reconnect), and the relay replaces this socket when the next one
            // joins, so 5 s here was 5 s of every reconnect after a network change.
            deadline = setTimeout(() => resolve(false), 1500);
          }),
        ]);
        if (!closed) {
          // The transport has already detached frames and invalidated Noise. A missing TCP close
          // receipt says nothing about business side effects and cannot block a new handshake.
          reportSocketRetired("relay", "close_timeout");
          retireSocket(socket, "relay");
        }
      } finally {
        clearTimeout(deadline);
        offClosed();
        offClosed = () => {};
        closedSocket = Promise.resolve();
        socket = undefined;
      }
    })();
    return closing;
  };
  try {
    const transport = await ready;
    active.throwIfAborted();
    return {
      transport,
      signal: active,
      close,
      /** Fixed code for why the room ended; undefined while open. */
      reason: () => (active.aborted ? (ended ?? "relay_closed") : undefined),
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
    active.removeEventListener("abort", abort);
  }
}
