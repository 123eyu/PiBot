import {
  type Port,
  PortCancelMessageSchema,
  PortReservedMessageSchema,
  type PortStreamMessageSchema,
} from "@pibot/protocol-base";
import type { z } from "zod";
import { LinkError, MAX_PLAINTEXT, text, utf8 } from "../core/bytes.ts";
import type { NoiseChannel } from "../noise/channel.ts";
export interface BinaryTransport {
  readonly kind: "relay" | "direct";
  readonly closed: AbortSignal;
  send(frame: Uint8Array): void;
  subscribe(listener: (frame: Uint8Array) => void): () => void;
  bufferedAmount(): number;
  close(): void;
  confirm?(): void;
}
export function encryptedPort(
  channel: NoiseChannel,
  transport: BinaryTransport,
  options: { signal: AbortSignal; onError?: (code: string) => void },
): Port {
  let closed = false;
  const listeners = new Set<(message: unknown) => void>();
  const cancelListeners = new Set<(id: string) => void>();
  const streamListeners = new Set<(message: z.output<typeof PortStreamMessageSchema>) => void>();
  const closeListeners = new Set<() => void>();
  const dispose = () => {
    if (closed) return;
    closed = true;
    off();
    options.signal.removeEventListener("abort", dispose);
    transport.closed.removeEventListener("abort", dispose);
    for (const listener of closeListeners) {
      try {
        listener();
      } catch {
        /* Closing one owner must continue releasing the remaining owners. */
      }
    }
    listeners.clear();
    cancelListeners.clear();
    streamListeners.clear();
    closeListeners.clear();
    channel.dispose();
    transport.close();
  };
  const off = transport.subscribe((frame) => {
    if (closed) return;
    let value: unknown;
    try {
      value = JSON.parse(text(channel.open(frame)));
    } catch {
      try {
        options.onError?.("invalid_encrypted_message");
      } finally {
        dispose();
      }
      return;
    }
    const reserved = PortReservedMessageSchema.safeParse(value);
    if (reserved.success) {
      if (reserved.data.$pibot === "rpc.cancel") {
        for (const listener of cancelListeners) {
          try {
            listener(reserved.data.id);
          } catch {
            /* One cancellation subscriber cannot block another or close the link. */
          }
        }
      } else {
        for (const listener of streamListeners) {
          try {
            listener(reserved.data);
          } catch {
            /* One stream consumer cannot block another or close the link. */
          }
        }
      }
      // Stream frames are reserved for the runner and must not enter the JSON-RPC business plane.
      return;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "$pibot")
    ) {
      try {
        options.onError?.("invalid_reserved_message");
      } finally {
        dispose();
      }
      return;
    }
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        /* One subscriber cannot block the others or resource cleanup. */
      }
    }
  });
  if (options.signal.aborted) dispose();
  else options.signal.addEventListener("abort", dispose, { once: true });
  if (transport.closed.aborted) dispose();
  else transport.closed.addEventListener("abort", dispose, { once: true });
  const send = (message: unknown) => {
    if (closed) throw new LinkError("port_closed");
    const bytes = utf8(JSON.stringify(message));
    if (bytes.length > MAX_PLAINTEXT) throw new LinkError("frame_too_large");
    try {
      transport.send(channel.seal(bytes));
    } catch (error) {
      dispose();
      throw error;
    }
  };
  return {
    post: send,
    onMessage(listener) {
      if (closed) throw new LinkError("port_closed");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancelRequest(id) {
      send(PortCancelMessageSchema.parse({ $pibot: "rpc.cancel", id }));
    },
    onRequestCancel(listener) {
      if (closed) throw new LinkError("port_closed");
      cancelListeners.add(listener);
      return () => {
        cancelListeners.delete(listener);
      };
    },
    sendStream(message) {
      send(PortReservedMessageSchema.parse(message));
    },
    onRequestStream(listener) {
      if (closed) throw new LinkError("port_closed");
      streamListeners.add(listener);
      return () => {
        streamListeners.delete(listener);
      };
    },
    onClose(listener) {
      if (closed) {
        queueMicrotask(listener);
        return () => {};
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    dispose,
  };
}
