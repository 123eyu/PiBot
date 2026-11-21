import { LinkError } from "../core/bytes.ts";
import type { DataChannelEvent, DataChannelLike } from "./datachannel.ts";

/** The other side may start Noise before our relay-delivered ready notification arrives. */
export function bufferChannel(raw: DataChannelLike): DataChannelLike {
  const listeners = new Set<(event: DataChannelEvent) => void>();
  const queued: DataChannelEvent[] = [];
  let bytes = 0;
  let attached = false;
  let closed = false;
  const retire = () => {
    if (closed) return;
    closed = true;
    raw.removeEventListener("message", receive);
    raw.removeEventListener("close", retire);
    raw.removeEventListener("error", retire);
    queued.length = 0;
    listeners.clear();
  };
  const receive = (event: DataChannelEvent) => {
    if (closed) return;
    if (!attached || queued.length) {
      bytes += event.data instanceof ArrayBuffer ? event.data.byteLength : 2_097_153;
      if (bytes > 2_097_152 || queued.length >= 128) {
        retire();
        raw.close();
        return;
      }
      queued.push(event);
    } else for (const fn of listeners) fn(event);
  };
  raw.addEventListener("message", receive);
  raw.addEventListener("close", retire);
  raw.addEventListener("error", retire);
  return {
    get readyState() {
      return raw.readyState;
    },
    get binaryType() {
      return raw.binaryType;
    },
    set binaryType(value) {
      raw.binaryType = value;
    },
    get bufferedAmount() {
      return raw.bufferedAmount;
    },
    get bufferedAmountLowThreshold() {
      return raw.bufferedAmountLowThreshold;
    },
    set bufferedAmountLowThreshold(value) {
      raw.bufferedAmountLowThreshold = value;
    },
    send: (data) => raw.send(data),
    close: () => {
      retire();
      raw.close();
    },
    addEventListener(type, fn) {
      if (type !== "message") return raw.addEventListener(type, fn);
      if (closed) throw new LinkError("direct_channel_closed");
      listeners.add(fn);
      attached = true;
      queueMicrotask(() => {
        bytes = 0;
        for (const event of queued.splice(0)) for (const listener of listeners) listener(event);
      });
    },
    removeEventListener(type, fn) {
      if (type === "message") listeners.delete(fn);
      else raw.removeEventListener(type, fn);
    },
  };
}
