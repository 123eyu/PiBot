import { Writable } from "node:stream";
import { ExecError } from "../core/types.ts";
import { RollingLog } from "./rolling-log.ts";

/** Adapt bounded background logging to the existing foreground stream/backpressure owner. */
export async function createRollingCommandLog(path: string) {
  let resume: (() => void) | undefined;
  const rolling = await RollingLog.create(
    path,
    () => {
      const callback = resume;
      resume = undefined;
      callback?.();
    },
    () => stream.destroy(new ExecError("output_failed")),
  );
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (rolling.write(chunk.toString("utf8"))) callback();
      else resume = callback;
    },
    final(callback) {
      void rolling.close().then(() => callback(), callback);
    },
    destroy(error, callback) {
      resume = undefined;
      void rolling.close().then(() => callback(error), callback);
    },
  });
  return { stream, close: () => rolling.close() };
}
