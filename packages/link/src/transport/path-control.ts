import { z } from "zod";
import { LinkError } from "../core/bytes.ts";

export const PathControlSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  method: z.enum([
    "link.path.prepare",
    "link.path.ready",
    "link.path.commit",
    "link.path.ack",
    "link.path.fallback",
  ]),
  params: z.strictObject({ id: z.number().int().nonnegative().safe() }),
});
export type PathControl = z.output<typeof PathControlSchema>;

export function waitFor(signal: AbortSignal, predicate: () => boolean, timeoutMs = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const end = Date.now() + timeoutMs;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new LinkError("path_closed"));
    const check = () => {
      if (signal.aborted) return abort();
      if (predicate()) return finish();
      if (Date.now() >= end) return finish(new LinkError("path_switch_timeout"));
      timer = setTimeout(check, 20);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

export function pathDelay(signal: AbortSignal, ms: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

export function pathClosed(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
