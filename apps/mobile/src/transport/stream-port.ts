import { EventEnvelopeSchema, type MethodResults, type Port, RpcErrorCodes } from "@pibot/protocol";

type Replay = MethodResults["events.resume"];
interface Attachment {
  /** The connection this port is attached to ended (a request cancelled then was cut off). */
  closed: AbortSignal;
  /** Too many live events queued behind events.resume: give this connection up. */
  overflow(): void;
}
/**
 * The business Peer's port for one desktop event stream (maintainers 2026-11-14, phone-sync proposal 1).
 * The Peer, and with it every screen's subscriptions, lives as long as the stream; each connection
 * that can resume the stream is attached here below the RPC layer. While events.resume is in
 * flight live events queue (responses stay deliverable); delivery is in sequence order and never
 * repeats a sequence. Requests still unanswered when a connection is detached are failed at once
 * (their answers can no longer arrive) instead of waiting out their timeouts.
 */
export function streamPort() {
  let listener: ((message: unknown) => void) | undefined;
  let cancelListener: ((id: string) => void) | undefined;
  let raw: Port | undefined;
  let attachment: Attachment | undefined;
  let offs: (() => void)[] = [];
  let syncing = false,
    seq = 0,
    size = 0,
    disposed = false,
    interrupted = false;
  const queued: Replay = [];
  const outstanding = new Set<string>();
  /**
   * Requests the path refused with `transport_switching` (relay frozen until idle, or the old
   * path already deselected). They were never sent, so they go out once the switch settles
   * (maintainers 2026-11-14: calls made in the path-switch gap used to fail).
   */
  const held: { id: string; message: unknown; deadline: number }[] = [];
  let retry: ReturnType<typeof setTimeout> | undefined;
  const send = (id: string | undefined, message: unknown) => {
    if (!raw) throw new Error("offline");
    if (id) outstanding.add(id);
    try {
      raw.post(message);
    } catch (error) {
      if (id) outstanding.delete(id);
      throw error;
    }
  };
  const switching = (error: unknown) =>
    error instanceof Error && error.message === "transport_switching";
  const flush = () => {
    clearTimeout(retry);
    retry = undefined;
    const now = Date.now();
    while (held.length && raw) {
      const head = held[0] as (typeof held)[number];
      // The caller's own timer rejected it already; sending it now would be a stray call.
      if (head.deadline <= now) {
        held.shift();
        continue;
      }
      try {
        send(head.id, head.message);
        held.shift();
      } catch (error) {
        if (!switching(error)) {
          held.shift();
          listener?.({
            jsonrpc: "2.0",
            id: head.id,
            error: { code: RpcErrorCodes.closed, message: "connection_closed" },
          });
          continue;
        }
        break;
      }
    }
    // The freeze ends without a new path when the switch fails; look again shortly.
    if (held.length && raw) retry = setTimeout(flush, 100);
  };
  const post = (message: unknown, deadline = Date.now() + 30_000) => {
    const request = message as { id?: unknown; method?: unknown } | null;
    const id =
      request && typeof request.id === "string" && typeof request.method === "string"
        ? request.id
        : undefined;
    // Keep order: nothing overtakes a request that is already waiting for the switch.
    if (id && held.length) {
      if (!raw) throw new Error("offline");
      if (held.length >= 32) throw new Error("transport_switching");
      held.push({ id, message, deadline });
      return;
    }
    try {
      send(id, message);
    } catch (error) {
      if (!id || !switching(error) || held.length >= 32) throw error;
      held.push({ id, message, deadline });
      retry ??= setTimeout(flush, 100);
    }
  };
  const deliver = (event: Replay[number]) => {
    if (event.params.seq <= seq) return;
    listener?.(event);
    seq = event.params.seq;
  };
  const receive = (message: unknown) => {
    const event = EventEnvelopeSchema.safeParse(message);
    if (!event.success) {
      const reply = message as { id?: unknown; method?: unknown } | null;
      if (reply && typeof reply.id === "string" && reply.method === undefined)
        outstanding.delete(reply.id);
      listener?.(message);
      return;
    }
    if (!syncing) {
      deliver(event.data);
      return;
    }
    size += JSON.stringify(event.data).length;
    if (queued.length >= 256 || size > 1_000_000) {
      attachment?.overflow();
      return;
    }
    queued.push(event.data);
  };
  const detach = () => {
    clearTimeout(retry);
    retry = undefined;
    for (const off of offs) off();
    offs = [];
    raw = undefined;
    attachment = undefined;
    syncing = false;
    queued.length = 0;
    size = 0;
    if (!outstanding.size) return;
    // A read cut off by the drop leaves its screen stale: the next resume asks for a refresh.
    interrupted = true;
    const ids = [...outstanding];
    outstanding.clear();
    for (const id of ids)
      listener?.({
        jsonrpc: "2.0",
        id,
        error: { code: RpcErrorCodes.closed, message: "connection_closed" },
      });
  };
  return {
    port: {
      post: (message: unknown) => post(message),
      postRequest: (message: unknown, deadline: number) => post(message, deadline),
      cancelRequest(id: string) {
        const waiting = held.findIndex((item) => item.id === id);
        if (waiting >= 0) {
          held.splice(waiting, 1);
          return;
        }
        // The caller gave up because the connection went away: its screen did not get the answer.
        if (outstanding.delete(id) && attachment?.closed.aborted) interrupted = true;
        raw?.cancelRequest?.(id);
      },
      onRequestCancel(fn: (id: string) => void) {
        cancelListener = fn;
        return () => {
          cancelListener = undefined;
        };
      },
      onMessage(fn: (message: unknown) => void) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        outstanding.clear();
        held.length = 0;
        clearTimeout(retry);
        detach();
        listener = undefined;
        cancelListener = undefined;
      },
    } satisfies Port,
    /** Attach the next connection; live events queue until `finish`. */
    attach(next: Port, at: Attachment) {
      if (disposed) throw new Error("offline");
      detach();
      raw = next;
      attachment = at;
      syncing = true;
      offs = [
        next.onMessage(receive),
        next.onRequestCancel?.((id) => cancelListener?.(id)) ?? (() => {}),
      ];
      // Requests held during a path switch go out on the path that replaced it.
      flush();
    },
    /** The connection ended: unanswered requests fail now; the stream and its cursor stay. */
    detach,
    /** events.resume answered (`reset`: the stream could not be resumed; start over at 0). */
    finish(events: Replay, reset = false) {
      if (reset) seq = 0;
      for (const event of [...events, ...queued].sort((a, b) => a.params.seq - b.params.seq))
        deliver(event);
      queued.length = 0;
      size = 0;
      syncing = false;
    },
    /** Start a new stream after this sequence (the desktop's position when it answered). */
    reset(after: number) {
      seq = after;
    },
    seq: () => seq,
    /** Whether a request was cut off since the last call; clears the mark. */
    takeInterrupted() {
      const value = interrupted;
      interrupted = false;
      return value;
    },
  };
}
export type StreamPort = ReturnType<typeof streamPort>;
