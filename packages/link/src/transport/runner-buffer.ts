import { LinkError, MAX_FRAME } from "../core/bytes.ts";
import type { BinaryTransport } from "./port.ts";

/** A socket can deliver handshake and identity frames in one batch, before await installs the next owner. */
export function bufferRunnerTransport(wire: BinaryTransport): BinaryTransport {
  const listeners = new Set<(frame: Uint8Array) => void>();
  const frames: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const clear = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    off();
    wire.closed.removeEventListener("abort", clear);
    for (const frame of frames) frame.fill(0);
    frames.length = 0;
    bytes = 0;
    listeners.clear();
  };
  const flush = () => {
    if (timer || closed || !listeners.size || !frames.length) return;
    // Async handshakes return a Port before their caller can install its business Peer.
    // Yield one task, so this includes that caller's await continuation, not just our subscriber.
    timer = setTimeout(() => {
      timer = undefined;
      while (!closed && listeners.size && frames.length) {
        const frame = frames.shift();
        if (!frame) break;
        bytes -= frame.length;
        try {
          for (const listener of [...listeners]) listener(frame);
        } catch {
          // A failed protocol consumer retires the generation; never release queued data to a new peer.
          wire.close();
        }
      }
    }, 0);
  };
  const off = wire.subscribe((frame) => {
    if (closed) return;
    if (frames.length >= 32 || bytes + frame.length > 4 * MAX_FRAME) {
      wire.close();
      return;
    }
    frames.push(frame.slice());
    bytes += frame.length;
    flush();
  });
  wire.closed.addEventListener("abort", clear, { once: true });
  if (wire.closed.aborted) clear();
  return {
    ...wire,
    subscribe(listener) {
      if (closed) throw new LinkError("transport_closed");
      listeners.add(listener);
      // Never invoke synchronously: subscribers must finish installing their own cleanup first.
      flush();
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      clear();
      wire.close();
    },
  };
}
