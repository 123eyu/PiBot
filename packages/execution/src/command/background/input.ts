import type { Writable } from "node:stream";
import { ExecError } from "../../core/types.ts";

export const MAX_STDIN_BYTES = 64 * 1024;

/** One bounded write in flight: cancellation must never leave a queued input behind. */
export function createBackgroundInput(options: {
  stream?: Writable;
  running(): boolean;
  stop(): Promise<void>;
}) {
  let busy = false;
  let closed = false;
  // A child can close stdin between calls; no raw stream error may escape to the caller/log.
  const onError = () => {
    closed = true;
  };
  options.stream?.on("error", onError);
  return {
    async write(
      text: string,
      eof: boolean,
      signal: AbortSignal,
      assertAuthorized: () => void | Promise<void>,
    ) {
      if (Buffer.byteLength(text) > MAX_STDIN_BYTES || (!text.length && !eof))
        throw new ExecError("invalid_input");
      signal.throwIfAborted();
      if (busy) throw new ExecError("busy");
      const stream = options.stream;
      if (closed || !options.running() || !stream || stream.destroyed || stream.writableEnded)
        throw new ExecError("command_failed", "stdin_closed");
      busy = true;
      let dispatched = false;
      const current = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            current.removeEventListener("abort", abort);
            stream.removeListener("error", fail);
            stream.removeListener("close", fail);
            error ? reject(error) : resolve();
          };
          const fail = () => finish(new ExecError("command_failed", "stdin_unconfirmed"));
          const abort = () => finish(new ExecError("command_failed", "stdin_unconfirmed"));
          current.addEventListener("abort", abort, { once: true });
          stream.once("error", fail);
          stream.once("close", fail);
          void Promise.resolve()
            .then(async () => {
              current.throwIfAborted();
              await assertAuthorized();
              if (!options.running()) throw new ExecError("closed");
              dispatched = true;
              if (eof) {
                closed = true;
                stream.end(text, "utf8", () => finish());
              } else
                stream.write(text, "utf8", (error) =>
                  finish(error ? new ExecError("command_failed", "stdin_unconfirmed") : undefined),
                );
            })
            .catch((error: unknown) =>
              finish(
                error instanceof ExecError && error.code === "authorization_changed"
                  ? error
                  : new ExecError("command_failed", "stdin_unconfirmed"),
              ),
            );
        });
        return { bytes: Buffer.byteLength(text), eof };
      } catch (error) {
        if (dispatched) {
          closed = true;
          await options.stop();
        }
        throw error;
      } finally {
        busy = false;
      }
    },
    dispose() {
      closed = true;
      // Keep the fixed error sink until close, including late EPIPE callbacks.
      const stream = options.stream;
      if (stream?.closed) stream.removeListener("error", onError);
      else stream?.once("close", () => stream.removeListener("error", onError));
      stream?.destroy();
    },
  };
}
