import {
  BRIDGE_PEERS,
  BRIDGE_REQUESTS,
  BridgeCommandSchema,
  type BridgeEvent,
  BridgeEventSchema,
} from "../../link-bridge/protocol.ts";
import { RendererRtcPeer } from "./peer.ts";

function attach(port: MessagePort) {
  const peers = new Map<string, { peer: RendererRtcPeer; tail: Promise<unknown> }>();
  const requests = new Set<number>();
  let disposed = false;
  const post = (event: BridgeEvent) => {
    if (disposed) return;
    const parsed = BridgeEventSchema.safeParse(event);
    if (!parsed.success) {
      closePeer(event.peer, true);
      return;
    }
    port.postMessage(parsed.data);
  };
  const closePeer = (id: string, failed: boolean) => {
    const entry = peers.get(id);
    if (!entry) return;
    peers.delete(id);
    entry.peer.close();
    post({ kind: "closed", peer: id, failed });
  };
  const dispose = () => {
    if (disposed) return;
    for (const id of peers.keys()) closePeer(id, true);
    disposed = true;
    requests.clear();
    port.onmessage = null;
    port.onmessageerror = null;
    port.close();
    window.removeEventListener("pagehide", dispose);
  };
  port.onmessage = (event: MessageEvent<unknown>) => {
    if (disposed) return;
    const parsed = BridgeCommandSchema.safeParse(event.data);
    if (!parsed.success) return dispose();
    const value = parsed.data;
    try {
      if (value.kind === "request") {
        if (requests.size >= BRIDGE_REQUESTS || requests.has(value.id)) return dispose();
        const operation = value.operation;
        if (operation.type === "create") {
          if (peers.size >= BRIDGE_PEERS || peers.has(value.peer))
            throw new Error("link_bridge_capacity");
          const peer = new RendererRtcPeer(
            value.peer,
            operation.role,
            post,
            (failed) => closePeer(value.peer, failed),
            operation.stunUrl,
          );
          peers.set(value.peer, { peer, tail: Promise.resolve() });
          post({ kind: "result", peer: value.peer, id: value.id, ok: true });
          return;
        }
        const entry = peers.get(value.peer);
        if (!entry) throw new Error("link_bridge_closed");
        requests.add(value.id);
        const run = async () => {
          try {
            const result = await entry.peer.execute(operation);
            if (peers.get(value.peer) === entry)
              post({
                kind: "result",
                peer: value.peer,
                id: value.id,
                ok: true,
                ...(result === undefined ? {} : { value: result }),
              });
          } catch {
            closePeer(value.peer, true);
          } finally {
            requests.delete(value.id);
          }
        };
        // Waiting for open must not block the remote candidates needed to open the channel.
        if (operation.type === "wait") void run();
        else entry.tail = entry.tail.then(run);
        return;
      }
      const entry = peers.get(value.peer);
      if (!entry) return;
      switch (value.kind) {
        case "close":
          closePeer(value.peer, false);
          break;
        case "send":
          entry.peer.send(value.sequence, value.frame);
          break;
        case "received":
          entry.peer.received(value.bytes, value.sequence);
          break;
        case "threshold":
          entry.peer.threshold(value.value);
          break;
      }
    } catch {
      if (peers.has(value.peer)) closePeer(value.peer, true);
      else if (value.kind === "request")
        post({ kind: "result", peer: value.peer, id: value.id, ok: false });
    }
  };
  port.onmessageerror = dispose;
  window.addEventListener("pagehide", dispose, { once: true });
  port.start();
}

const receive = (event: MessageEvent<unknown>) => {
  if (
    event.source !== window ||
    event.data !== "pibot:link-bridge-port" ||
    event.ports.length !== 1
  )
    return;
  const port = event.ports[0];
  if (!port) return;
  window.removeEventListener("message", receive);
  attach(port);
};
window.addEventListener("message", receive);
