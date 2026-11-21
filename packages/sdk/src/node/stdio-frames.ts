import type { Readable, Writable } from "node:stream";
import { ACP_MAX_FRAME } from "@pibot/protocol/background";

/** Geometric growth bounds both retained bytes and fragmentation metadata. */
export async function* readAcpFrames(input: Readable) {
  let buffer = Buffer.alloc(4096);
  let size = 0;
  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const length = end - offset;
      if (size + length > ACP_MAX_FRAME) throw new Error("acp_frame_too_large");
      if (size + length > buffer.length) {
        const grown = Buffer.allocUnsafe(
          Math.min(ACP_MAX_FRAME, Math.max(size + length, buffer.length * 2)),
        );
        buffer.copy(grown, 0, 0, size);
        buffer = grown;
      }
      chunk.copy(buffer, size, offset, end);
      size += length;
      offset = end;
      if (newline < 0) continue;
      const text = buffer.subarray(0, size).toString("utf8").trim();
      size = 0;
      if (text) yield JSON.parse(text) as unknown;
    }
  }
  if (size) {
    const text = buffer.subarray(0, size).toString("utf8").trim();
    if (text) yield JSON.parse(text) as unknown;
  }
}

export async function writeAcpFrame(output: Writable, message: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
  if (bytes.length > ACP_MAX_FRAME) throw new Error("acp_frame_too_large");
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error | null) => {
      clearTimeout(timer);
      output.off("close", closed);
      output.off("error", finish);
      error ? reject(error) : resolve();
    };
    const closed = () => finish(new Error("acp_output_closed"));
    const timer = setTimeout(() => {
      finish(new Error("acp_output_timeout"));
      output.destroy();
    }, 15_000);
    output.once("close", closed);
    output.once("error", finish);
    output.write(bytes, (error) => {
      // Writable emits error after its callback; keep the listener until that event.
      if (error) {
        clearTimeout(timer);
        reject(error);
      } else finish();
    });
  });
}
