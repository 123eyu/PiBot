import type { Socket } from "node:net";
import {
  type BackgroundWire,
  BackgroundWireSchema,
  FILE_LIMIT,
  MAX_ATTACHMENTS,
} from "@pibot/protocol/background";

// Five maximum-size base64 files still fit; only one such frame may be buffered per connection.
export const MAX_FRAME = Math.ceil(FILE_LIMIT / 3) * 4 * MAX_ATTACHMENTS + 1024 * 1024;
const MAX_BUFFER = MAX_FRAME + 4;
export function framedSocket(
  socket: Socket,
  receive: (message: BackgroundWire, bytes: number) => void | Promise<void>,
  limit = MAX_FRAME,
  reserve?: (bytes: number) => (() => void) | undefined,
) {
  let header = Buffer.alloc(4),
    headerBytes = 0;
  let payload: Buffer | undefined,
    payloadBytes = 0;
  let closed = false;
  let waiting = false;
  let release: (() => void) | undefined;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  function fail() {
    clearTimeout(frameTimer);
    release?.();
    release = undefined;
    closed = true;
    socket.destroy();
  }
  const data = (chunk: Buffer) => {
    let offset = 0;
    while (!closed && offset < chunk.length) {
      if (!payload) {
        if (headerBytes === 0) {
          clearTimeout(frameTimer);
          frameTimer = setTimeout(fail, 15_000);
        }
        const count = Math.min(4 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + count);
        offset += count;
        headerBytes += count;
        if (headerBytes < 4) continue;
        const length = header.readUInt32BE();
        if (length === 0 || length > limit) {
          fail();
          return;
        }
        if (reserve) {
          release = reserve(length);
          if (!release) {
            fail();
            return;
          }
        }
        clearTimeout(frameTimer);
        frameTimer = setTimeout(fail, 15_000);
        payload = Buffer.allocUnsafe(length);
        payloadBytes = 0;
      }
      const count = Math.min(payload.length - payloadBytes, chunk.length - offset);
      chunk.copy(payload, payloadBytes, offset, offset + count);
      offset += count;
      payloadBytes += count;
      if (payloadBytes !== payload.length) continue;
      try {
        const message = BackgroundWireSchema.parse(JSON.parse(payload.toString("utf8")));
        const length = payload.length;
        payload = undefined;
        headerBytes = 0;
        clearTimeout(frameTimer);
        release?.();
        release = undefined;
        const received = receive(message, length);
        if (received) {
          socket.pause();
          const remaining = chunk.subarray(offset);
          void received
            .then(() => {
              if (closed) return;
              waiting = false;
              if (remaining.length) data(remaining);
              if (!waiting) socket.resume();
            })
            .catch(fail);
          waiting = true;

          return;
        }
      } catch {
        fail();
      }
    }
  };
  socket.on("data", data);
  socket.on("error", fail);
  socket.once("close", () => {
    clearTimeout(frameTimer);
    release?.();
    release = undefined;
    closed = true;
    payload = undefined;
    header = Buffer.alloc(0);
  });
  return {
    send(message: BackgroundWire) {
      if (closed) throw new Error("background_disconnected");
      const bytes = Buffer.from(JSON.stringify(BackgroundWireSchema.parse(message)));
      if (
        bytes.length > limit ||
        socket.writableLength + bytes.length + 4 > Math.min(MAX_BUFFER, limit + 4)
      ) {
        fail();
        throw new Error("background_backpressure");
      }
      const prefix = Buffer.allocUnsafe(4);
      prefix.writeUInt32BE(bytes.length);
      socket.cork();
      socket.write(prefix);
      socket.write(bytes);
      socket.uncork();
    },
    close: fail,
    limit(bytes: number) {
      limit = bytes;
    },
    async sendAsync(message: BackgroundWire) {
      const bytes = Buffer.from(JSON.stringify(BackgroundWireSchema.parse(message)));
      if (
        closed ||
        bytes.length > limit ||
        socket.writableLength + bytes.length + 4 > Math.min(MAX_BUFFER, limit + 4)
      )
        throw new Error("background_backpressure");
      const prefix = Buffer.allocUnsafe(4);
      prefix.writeUInt32BE(bytes.length);
      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error | null) => {
          clearTimeout(timer);
          socket.off("close", lost);
          error ? reject(error) : resolve();
        };
        const lost = () => done(new Error("background_disconnected"));
        const timer = setTimeout(() => {
          fail();
          done(new Error("background_backpressure"));
        }, 15_000);
        socket.once("close", lost);
        socket.cork();
        socket.write(prefix);
        socket.write(bytes, done);
        socket.uncork();
      });
    },
    authenticated() {
      limit = MAX_FRAME;
    },
  };
}
