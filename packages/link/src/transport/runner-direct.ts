import type { Port } from "@pibot/protocol-base";
import { z } from "zod";
import type { RandomBytes } from "../core/bytes.ts";
import type { EndpointKeys } from "../keys/endpoint.ts";
import { connectRunnerSession } from "../pairing/runner-session.ts";
import { lanSocket } from "./lan-socket.ts";
import { bufferRunnerTransport } from "./runner-buffer.ts";
import { createRunnerDrain } from "./runner-retry.ts";
import type { SocketLike } from "./socket.ts";

/** Authentication and admission are separate: both old business owners must drain before ready. */
export async function connectRunnerSocket(
  socket: SocketLike,
  options: {
    keys: EndpointKeys;
    publicKey: string;
    role: "initiator" | "responder";
    signal: AbortSignal;
    random?: RandomBytes;
    authorizationSignature?: string;
  },
) {
  const wire = lanSocket(socket, options.signal);
  let raw: Port;
  try {
    raw = await connectRunnerSession({
      ...options,
      random: options.random ?? ((length) => crypto.getRandomValues(new Uint8Array(length))),
      timeoutMs: 5000,
      transport: bufferRunnerTransport(wire.transport),
    });
  } catch (error) {
    await createRunnerDrain([() => wire.close()], options.signal, () => {})();
    throw error;
  }
  if (wire.transport.closed.aborted) {
    await createRunnerDrain([() => wire.close()], options.signal, () => {})();
    throw new Error("runner_transport_closed");
  }
  return admitRunnerPort(raw, wire.transport.closed, () => wire.close(), options.role);
}

export function admitRunnerPort(
  raw: Port,
  closedSignal: AbortSignal,
  close: () => Promise<void>,
  role: "initiator" | "responder",
) {
  let selected = false;
  let selectedResolve!: () => void;
  let selectedReject!: (error: Error) => void;
  const selection = new Promise<void>((resolve, reject) => {
    selectedResolve = resolve;
    selectedReject = reject;
  });
  void selection.catch(() => {});
  const expire = setTimeout(() => raw.dispose?.(), 30_000);
  const closed = () => {
    clearTimeout(expire);
    selectedReject(new Error("runner_selection_closed"));
  };
  closedSignal.addEventListener("abort", closed, { once: true });
  if (closedSignal.aborted) closed();
  const control = z.strictObject({
    jsonrpc: z.literal("2.0"),
    method: z.enum(["link.runner.ready", "link.runner.select"]),
    params: z.strictObject({}),
  });
  let ready = false;
  let admitted = false;
  const listeners = new Set<(value: unknown) => void>();
  const queued: unknown[] = [];
  let bytes = 0;
  let notify = () => {};
  let flush: ReturnType<typeof setTimeout> | undefined;
  const deliver = () => {
    if (flush || !admitted || !listeners.size || !queued.length) return;
    flush = setTimeout(() => {
      flush = undefined;
      if (!listeners.size || closedSignal.aborted) return;
      for (const value of queued.splice(0)) for (const listener of [...listeners]) listener(value);
      bytes = 0;
    }, 0);
  };
  closedSignal.addEventListener(
    "abort",
    () => {
      clearTimeout(flush);
      queued.length = 0;
      listeners.clear();
    },
    { once: true },
  );
  const off = raw.onMessage((value) => {
    const message = value as { jsonrpc?: unknown; method?: unknown; params?: unknown } | null;
    if (message?.method === "link.runner.select" || message?.method === "link.runner.ready") {
      if (
        !control.safeParse(value).success ||
        (message.method === "link.runner.select"
          ? selected || role !== "initiator"
          : ready || !selected)
      ) {
        raw.dispose?.();
        return;
      }
      if (message.method === "link.runner.select") {
        selected = true;
        selectedResolve();
      } else {
        ready = true;
        notify();
      }
      return;
    }
    if (!ready) return raw.dispose?.();
    if (!admitted || !listeners.size || queued.length) {
      bytes += JSON.stringify(value).length;
      if (queued.length >= 32 || bytes > 4 * 1024 * 1024) return raw.dispose?.();
      queued.push(value);
      deliver();
    } else for (const listener of listeners) listener(value);
  });
  let activation: Promise<void> | undefined;
  // Reserved frames cannot reach business consumers before both old generations have drained.
  raw.onRequestCancel?.(() => {
    if (!admitted) raw.dispose?.();
  });
  raw.onRequestStream?.(() => {
    if (!admitted) raw.dispose?.();
  });
  const port: Port = {
    ...raw,
    post(value) {
      if (!admitted) throw new Error("runner_not_admitted");
      raw.post(value);
    },
    onMessage(listener) {
      listeners.add(listener);
      deliver();
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    port,
    signal: closedSignal,
    selected: () => selection,
    select() {
      if (role !== "responder") throw new Error("runner_selection_role");
      if (selected) return;
      selected = true;
      raw.post({ jsonrpc: "2.0", method: "link.runner.select", params: {} });
      selectedResolve();
    },
    activate() {
      activation ??= new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(false), 15_000);
        const abort = () => finish(false);
        const finish = (ok: boolean) => {
          clearTimeout(timer);
          closedSignal.removeEventListener("abort", abort);
          notify = () => {};
          if (ok) {
            clearTimeout(expire);
            admitted = true;
            deliver();
            resolve();
          } else {
            raw.dispose?.();
            reject(new Error("runner_admission_failed"));
          }
        };
        notify = () => {
          if (ready) finish(true);
        };
        closedSignal.addEventListener("abort", abort, { once: true });
        try {
          if (!selected) throw new Error("runner_not_selected");
          raw.post({ jsonrpc: "2.0", method: "link.runner.ready", params: {} });
          if (closedSignal.aborted) abort();
          else notify();
        } catch {
          finish(false);
        }
      });
      return activation;
    },
    async close() {
      clearTimeout(expire);
      closedSignal.removeEventListener("abort", closed);
      selectedReject(new Error("runner_selection_closed"));
      off();
      queued.length = 0;
      listeners.clear();
      raw.dispose?.();
      await close();
    },
  };
}
