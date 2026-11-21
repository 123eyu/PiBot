import type { Readable, Writable } from "node:stream";
import { type Port, PortCancelMessageSchema, PortStreamMessageSchema } from "@pibot/protocol-base";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_WRITE_BYTES = 4 * 1024 * 1024;

/** NDJSON transport used only by explicitly built package acceptance fixtures. */
export function createFixturePort(input: Readable, output: Writable): Port {
  const messages = new Set<(message: unknown) => void>();
  const cancels = new Set<(id: string) => void>();
  const streams = new Set<(message: never) => void>();
  const closes = new Set<() => void>();
  let buffered = Buffer.alloc(0);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    input.off("data", onData);
    input.off("end", close);
    input.off("error", close);
    output.off("error", close);
    for (const listener of closes) listener();
    messages.clear();
    cancels.clear();
    streams.clear();
    closes.clear();
  };
  const dispatch = (value: unknown) => {
    const cancel = PortCancelMessageSchema.safeParse(value);
    if (cancel.success) {
      for (const listener of cancels) listener(cancel.data.id);
      return;
    }
    const stream = PortStreamMessageSchema.safeParse(value);
    if (stream.success) {
      for (const listener of streams) listener(stream.data as never);
      return;
    }
    for (const listener of messages) listener(value);
  };
  const onData = (chunk: Buffer | string) => {
    if (closed) return;
    buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (;;) {
      const newline = buffered.indexOf(10);
      if (newline < 0) break;
      if (newline > MAX_FRAME_BYTES) return close();
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (!line.length) continue;
      try {
        dispatch(JSON.parse(line.toString("utf8")));
      } catch {
        return close();
      }
    }
    if (buffered.length > MAX_FRAME_BYTES) close();
  };
  const send = (value: unknown) => {
    if (closed) throw new Error("fixture_port_closed");
    const frame = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (
      frame.length > MAX_FRAME_BYTES ||
      output.writableLength + frame.length > MAX_PENDING_WRITE_BYTES
    ) {
      close();
      throw new Error("fixture_port_capacity");
    }
    output.write(frame);
  };
  input.on("data", onData);
  input.once("end", close);
  input.once("error", close);
  output.once("error", close);
  return {
    post: send,
    postRequest: send,
    onMessage(listener) {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    cancelRequest(id) {
      send({ $pibot: "rpc.cancel", id });
    },
    onRequestCancel(listener) {
      cancels.add(listener);
      return () => cancels.delete(listener);
    },
    sendStream: send,
    onRequestStream(listener) {
      streams.add(listener as (message: never) => void);
      return () => streams.delete(listener as (message: never) => void);
    },
    onClose(listener) {
      if (closed) queueMicrotask(listener);
      else closes.add(listener);
      return () => closes.delete(listener);
    },
    dispose() {
      close();
      output.end();
    },
  };
}
