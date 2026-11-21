import { LinkError, MAX_FRAME } from "../core/bytes.ts";
import type { BinaryTransport } from "./port.ts";

export const DATA_CHANNEL_FRAGMENT = 64 * 1024;
export const DATA_CHANNEL_HEADER = 8;
const FRAGMENT_PAYLOAD = DATA_CHANNEL_FRAGMENT - DATA_CHANNEL_HEADER;
const MAX_FRAGMENTS = Math.ceil(MAX_FRAME / FRAGMENT_PAYLOAD);
const MAX_PENDING_FRAMES = 32;
const MAX_PENDING_BYTES = 2 * MAX_FRAME;

export interface DataChannelEvent {
  readonly type: string;
  readonly data?: unknown;
}

export interface DataChannelLike {
  readonly readyState: "connecting" | "open" | "closing" | "closed";
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: string;
  send(data: ArrayBuffer): void;
  close(): void;
  addEventListener(type: string, listener: (event: DataChannelEvent) => void): void;
  removeEventListener(type: string, listener: (event: DataChannelEvent) => void): void;
}

export interface DataChannelTransportOptions {
  signal: AbortSignal;
  reassemblyTimeoutMs?: number;
  onBufferedAmountLow?: () => void;
  onError?: (code: string) => void;
}

interface Assembly {
  readonly total: number;
  readonly chunks: Array<Uint8Array | undefined>;
  received: number;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

function eventBytes(value: unknown) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new LinkError("invalid_frame");
}

function nextFrame(id: number) {
  return (id + 1) >>> 0;
}

/** Adapts an injected, already-open ordered DataChannel without importing a WebRTC runtime. */
export function dataChannelTransport(
  channel: DataChannelLike,
  options: DataChannelTransportOptions,
): BinaryTransport {
  const lifetime = new AbortController();
  const listeners = new Set<(frame: Uint8Array) => void>();
  const assemblies = new Map<number, Assembly>();
  const completed = new Map<number, Uint8Array>();
  let pendingBytes = 0;
  let sendingFrame = 1;
  let receivingFrame = 1;
  let stopped = false;

  const report = (code: string) => {
    try {
      options.onError?.(code);
    } catch {
      /* Diagnostics cannot interrupt transport cleanup. */
    }
  };
  const removeHandlers = () => {
    for (const [type, listener] of handlers) channel.removeEventListener(type, listener);
  };
  const retire = (closeChannel: boolean) => {
    if (stopped) return;
    stopped = true;
    options.signal.removeEventListener("abort", close);
    removeHandlers();
    for (const assembly of assemblies.values()) clearTimeout(assembly.timer);
    assemblies.clear();
    completed.clear();
    pendingBytes = 0;
    listeners.clear();
    lifetime.abort();
    if (closeChannel)
      try {
        channel.close();
      } catch {
        /* The closed signal is authoritative even when the adapter already failed. */
      }
  };
  const close = () => retire(true);
  const fail = (code: string) => {
    report(code);
    close();
  };
  const flush = () => {
    while (!stopped) {
      const frame = completed.get(receivingFrame);
      if (!frame) return;
      completed.delete(receivingFrame);
      pendingBytes -= frame.length;
      receivingFrame = nextFrame(receivingFrame);
      for (const listener of listeners) listener(frame.slice());
    }
  };
  const receive = (event: DataChannelEvent) => {
    if (stopped) return;
    try {
      const packet = eventBytes(event.data);
      if (packet.length < DATA_CHANNEL_HEADER || packet.length > DATA_CHANNEL_FRAGMENT)
        throw new LinkError("invalid_frame");
      const header = new DataView(packet.buffer, packet.byteOffset, DATA_CHANNEL_HEADER);
      const id = header.getUint32(0);
      const sequence = header.getUint16(4);
      const total = header.getUint16(6);
      const distance = (id - receivingFrame) >>> 0;
      if (
        total < 1 ||
        total > MAX_FRAGMENTS ||
        sequence >= total ||
        distance >= MAX_PENDING_FRAMES ||
        completed.has(id)
      )
        throw new LinkError("invalid_frame");
      const payload = packet.subarray(DATA_CHANNEL_HEADER);
      if (sequence + 1 < total && payload.length !== FRAGMENT_PAYLOAD)
        throw new LinkError("invalid_frame");
      let assembly = assemblies.get(id);
      if (!assembly) {
        const timer = setTimeout(
          () => fail("fragment_timeout"),
          options.reassemblyTimeoutMs ?? 10_000,
        );
        assembly = { total, chunks: Array(total), received: 0, bytes: 0, timer };
        assemblies.set(id, assembly);
      }
      if (assembly.total !== total || assembly.chunks[sequence])
        throw new LinkError("invalid_frame");
      const copy = payload.slice();
      assembly.chunks[sequence] = copy;
      assembly.received++;
      assembly.bytes += copy.length;
      pendingBytes += copy.length;
      if (assembly.bytes > MAX_FRAME || pendingBytes > MAX_PENDING_BYTES)
        throw new LinkError("transport_capacity");
      if (assembly.received !== total) return;
      clearTimeout(assembly.timer);
      assemblies.delete(id);
      const frame = new Uint8Array(assembly.bytes);
      let offset = 0;
      for (const chunk of assembly.chunks) {
        if (!chunk) throw new LinkError("invalid_frame");
        frame.set(chunk, offset);
        offset += chunk.length;
      }
      completed.set(id, frame);
      flush();
    } catch (error) {
      fail(error instanceof LinkError ? error.code : "invalid_frame");
    }
  };
  const ended = () => retire(false);
  const low = () => {
    try {
      options.onBufferedAmountLow?.();
    } catch {
      /* Capacity observers cannot retain a failed transport. */
    }
  };
  const handlers: [string, (event: DataChannelEvent) => void][] = [
    ["message", receive],
    ["close", ended],
    ["error", ended],
    ["bufferedamountlow", low],
  ];

  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = MAX_FRAME;
  for (const [type, listener] of handlers) channel.addEventListener(type, listener);
  if (channel.readyState === "closed") retire(false);
  else if (options.signal.aborted) close();
  else options.signal.addEventListener("abort", close, { once: true });

  return {
    kind: "direct",
    closed: lifetime.signal,
    send(frame) {
      if (stopped || channel.readyState !== "open") throw new LinkError("connection_closed");
      if (frame.length > MAX_FRAME || channel.bufferedAmount > 2 * MAX_FRAME)
        throw new LinkError("transport_capacity");
      const total = Math.max(1, Math.ceil(frame.length / FRAGMENT_PAYLOAD));
      const id = sendingFrame;
      sendingFrame = nextFrame(sendingFrame);
      try {
        for (let sequence = 0; sequence < total; sequence++) {
          const start = sequence * FRAGMENT_PAYLOAD;
          const payload = frame.subarray(start, Math.min(frame.length, start + FRAGMENT_PAYLOAD));
          const packet = new Uint8Array(DATA_CHANNEL_HEADER + payload.length);
          const header = new DataView(packet.buffer);
          header.setUint32(0, id);
          header.setUint16(4, sequence);
          header.setUint16(6, total);
          packet.set(payload, DATA_CHANNEL_HEADER);
          channel.send(packet.buffer);
        }
      } catch {
        close();
        throw new LinkError("connection_closed");
      }
    },
    subscribe(listener) {
      if (stopped) throw new LinkError("connection_closed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bufferedAmount: () => channel.bufferedAmount,
    close,
  };
}
