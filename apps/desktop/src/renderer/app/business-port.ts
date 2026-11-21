import { type Port, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { GUI_RPC_CAPACITY, GUI_RPC_QUEUE_LIMIT, guiRpcReservation } from "../../shared/gui-rpc.ts";

/** Only authenticated GUI ports opt into local scheduling envelopes. */
export function businessPort(port: MessagePort, scheduled = false): Port {
  const pending = new Set<string>();
  const timings = new Map<string, { method: string; at: number }>();
  const started = performance.now();
  let measured = 0;
  const observed = new Set([
    "settings.get",
    "bots.list",
    "groups.list",
    "sidebar.list",
    "topics.list",
    "chat.history",
    "inbox.list",
    "inbox.counts",
  ]);
  const complete = (id: string, ok: boolean) => {
    const timing = timings.get(id);
    timings.delete(id);
    if (timing)
      window.pibotStartup?.timing({
        method: timing.method,
        durationMs: performance.now() - timing.at,
        ok,
      });
  };
  return {
    post: (message) => port.postMessage(message),
    postRequest(message, deadline) {
      // createPeer already validated this request. Bound local IPC admission before cloning payloads.
      const request = message as { id: string; method: string };
      if (
        pending.size >=
        GUI_RPC_CAPACITY + GUI_RPC_QUEUE_LIMIT - guiRpcReservation(request.method)
      )
        throw new RpcError(RpcErrorCodes.busy, "GUI request queue full");
      pending.add(request.id);
      if (measured < 128 && performance.now() - started < 60_000 && observed.has(request.method)) {
        measured++;
        timings.set(request.id, { method: request.method, at: performance.now() });
      }
      try {
        port.postMessage(scheduled ? { kind: "request", message, deadline } : message);
      } catch (error) {
        complete(request.id, false);
        pending.delete(request.id);
        throw error;
      }
    },
    cancelRequest(id) {
      complete(id, false);
      pending.delete(id);
      if (scheduled) port.postMessage({ kind: "cancel", id });
    },
    dispose() {
      pending.clear();
      timings.clear();
      if (scheduled) port.postMessage({ kind: "dispose" });
    },
    onMessage(listener) {
      const receive = (event: MessageEvent) => {
        const value = event.data;
        if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
          complete(value.id, !("error" in value));
          pending.delete(value.id);
        }
        listener(value);
      };
      port.addEventListener("message", receive);
      port.start();
      return () => port.removeEventListener("message", receive);
    },
  };
}
