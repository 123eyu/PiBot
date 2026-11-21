import { randomUUID } from "node:crypto";
import { PathStatsSchema, type RtcPeerFactory, type RtcPeerLike, type RtcState } from "@pibot/link";
import {
  BRIDGE_PEERS,
  BRIDGE_REQUESTS,
  BRIDGE_TIMEOUT,
  type BridgeCommand,
  BridgeEventSchema,
  type BridgeOperation,
  type BridgePort,
} from "../../link-bridge/protocol.ts";
import { BridgeDataChannel } from "./channel.ts";

/** No Electron runtime dependency: the utility entry supplies its fourth transferred port. */
export function createDesktopRtcBridge(port: BridgePort) {
  const peers = new Map<
    string,
    {
      channel: BridgeDataChannel;
      candidates: Set<(candidate: string) => void>;
      diagnostic?: (event: RtcState) => void;
      close(failed: boolean, notify?: boolean): void;
    }
  >();
  const pending = new Map<
    number,
    {
      peer: string;
      resolve(value?: string): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 0;
  let disposed = false;
  const post = (command: BridgeCommand) => {
    if (disposed) throw new Error("link_bridge_closed");
    port.postMessage(command);
  };
  const request = (peer: string, operation: BridgeOperation) => {
    if (disposed || !peers.has(peer)) return Promise.reject(new Error("link_bridge_closed"));
    if (pending.size >= BRIDGE_REQUESTS) return Promise.reject(new Error("link_bridge_capacity"));
    const id = nextId++;
    return new Promise<string | undefined>((resolve, reject) => {
      const timer = setTimeout(() => peers.get(peer)?.close(true), BRIDGE_TIMEOUT);
      pending.set(id, { peer, resolve, reject, timer });
      try {
        post({ kind: "request", id, peer, operation });
      } catch {
        peers.get(peer)?.close(true);
      }
    });
  };
  const receive = (event: { data: unknown }) => {
    const parsed = BridgeEventSchema.safeParse(event.data);
    if (!parsed.success) return dispose();
    const value = parsed.data;
    const entry = peers.get(value.peer);
    if (!entry) return;
    if (value.kind === "diagnostic") {
      entry.diagnostic?.(value.diagnostic);
      return;
    }
    if (value.kind === "closed") return entry.close(value.failed, false);
    if (value.kind === "result") {
      const work = pending.get(value.id);
      if (!work || work.peer !== value.peer) return;
      clearTimeout(work.timer);
      pending.delete(value.id);
      if (value.ok) work.resolve(value.value);
      else {
        work.reject(new Error("link_bridge_failed"));
        entry.close(true);
      }
    } else if (value.kind === "candidate") {
      for (const listener of [...entry.candidates]) {
        try {
          listener(value.value);
        } catch {
          entry.close(true);
          break;
        }
      }
    } else entry.channel.receive(value);
  };
  const createPeer: RtcPeerFactory = async ({ role, signal, stunUrl, onDiagnostic }) => {
    signal.throwIfAborted();
    if (disposed || peers.size >= BRIDGE_PEERS) throw new Error("link_bridge_capacity");
    const id = randomUUID();
    const candidates = new Set<(candidate: string) => void>();
    let closed = false;
    const close = (failed: boolean, notify = true) => {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", abort);
      if (notify && !disposed) {
        try {
          post({ kind: "close", peer: id });
        } catch {
          /* Closing the stable port also retires its main-process owner. */
        }
      }
      peers.delete(id);
      for (const [key, work] of pending)
        if (work.peer === id) {
          clearTimeout(work.timer);
          pending.delete(key);
          work.reject(new Error("link_bridge_closed"));
        }
      candidates.clear();
      channel.finish(failed);
    };
    const abort = () => close(false);
    const channel = new BridgeDataChannel(id, post, close);
    peers.set(id, { channel, candidates, close, diagnostic: onDiagnostic });
    signal.addEventListener("abort", abort, { once: true });
    try {
      await request(id, { type: "create", role, stunUrl });
      signal.throwIfAborted();
      const describe = async (operation: BridgeOperation) => {
        const value = await request(id, operation);
        if (!value) {
          close(true);
          throw new Error("link_bridge_failed");
        }
        return value;
      };
      const peer: RtcPeerLike = {
        createDataChannel() {
          void request(id, { type: "channel" }).catch(() => close(true));
          return channel;
        },
        async waitDataChannel(selected) {
          if (selected && selected !== channel) throw new Error("invalid_bridge_channel");
          await request(id, { type: "wait" });
          if (channel.readyState !== "open") throw new Error("link_bridge_closed");
          return channel;
        },
        createOffer: () => describe({ type: "offer" }),
        acceptOffer: (sdp) => describe({ type: "acceptOffer", sdp }),
        acceptAnswer: async (sdp) => {
          await request(id, { type: "acceptAnswer", sdp });
        },
        addCandidate: async (candidate) => {
          await request(id, { type: "candidate", candidate });
        },
        onCandidate(listener) {
          candidates.add(listener);
          return () => candidates.delete(listener);
        },
        selectedPathKind: async () => {
          const value = await describe({ type: "pathKind" });
          return (value as "lan" | "punched" | "relay" | "unknown") ?? "unknown";
        },
        pathStats: async () => {
          // Diagnostics: an unreadable answer is "unknown", never a reason to retire the peer.
          const value = await request(id, { type: "pathStats" });
          try {
            return PathStatsSchema.parse(JSON.parse(value ?? ""));
          } catch {
            return { kind: "unknown" as const, pairs: 0, checking: 0 };
          }
        },
        close: () => close(false),
      };
      return peer;
    } catch {
      close(true);
      throw new Error("link_bridge_failed");
    }
  };
  function dispose() {
    if (disposed) return;
    for (const peer of [...peers.values()]) peer.close(true);
    disposed = true;
    port.off("message", receive);
    port.off("close", dispose);
    port.close();
  }
  port.on("message", receive);
  port.on("close", dispose);
  port.start();
  return { createPeer, dispose };
}
