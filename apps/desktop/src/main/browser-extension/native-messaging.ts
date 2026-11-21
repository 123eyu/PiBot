import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const NativeMessageSchema = z.record(z.string(), z.unknown());

/** Chrome/Firefox native messaging uses a little-endian uint32 length prefix. */
export async function* readNativeMessages(input: Readable): AsyncGenerator<unknown> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE_BYTES) throw new Error("native_message_too_large");
      if (buffer.length < length + 4) break;
      const body = buffer.subarray(4, length + 4);
      buffer = buffer.subarray(length + 4);
      let value: unknown;
      try {
        value = JSON.parse(body.toString("utf8"));
      } catch {
        throw new Error("native_message_invalid_json");
      }
      yield NativeMessageSchema.parse(value);
    }
    if (buffer.length > MAX_MESSAGE_BYTES + 4) throw new Error("native_message_too_large");
  }
  if (buffer.length !== 0) throw new Error("native_message_truncated");
}

export async function writeNativeMessage(output: Writable, value: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(NativeMessageSchema.parse(value)), "utf8");
  if (body.length > MAX_MESSAGE_BYTES) throw new Error("native_message_too_large");
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  if (!output.write(frame)) await once(output, "drain");
}

export interface NativeMessageBridge {
  run(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/** Bridges the browser's stdio stream to an already authenticated Pi Bot transport. */
export function createNativeMessageBridge(options: {
  input: Readable;
  output: Writable;
  send(message: unknown): Promise<void>;
  receive(handler: (message: unknown) => Promise<void> | void): () => void;
}): NativeMessageBridge {
  let stopped = false;
  let remove = () => {};
  return {
    async run(signal) {
      const abort = () => {
        stopped = true;
      };
      signal?.addEventListener("abort", abort, { once: true });
      remove = options.receive((message) => writeNativeMessage(options.output, message));
      try {
        for await (const message of readNativeMessages(options.input)) {
          if (stopped) break;
          await options.send(message);
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        remove();
        remove = () => {};
      }
    },
    async close() {
      stopped = true;
      remove();
      remove = () => {};
      options.input.destroy();
      if (!options.output.destroyed) options.output.end();
    },
  };
}
