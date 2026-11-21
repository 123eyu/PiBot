import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { Spec } from "./types.ts";

const HOST_READY_MS = 20_000;

/** Background SRT startup cannot dispatch a command until its caller revalidates authority. */
export async function hostReady(
  lifetime: AbortController,
  child: ChildProcess,
  host: NonNullable<Spec["host"]>,
  stop: () => Promise<void>,
) {
  const status = child.stdio[3] as Readable | null;
  child.stdin?.on("error", () => {});
  let preparation: Promise<void> | undefined;
  let preparationFailed = false;
  let preparationError: unknown;
  const ready = await new Promise<boolean>((resolve) => {
    if (!status) return resolve(false);
    let text = "";
    let settled = false;
    let sawPrepared = false;
    let dispatched = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      host.signal.removeEventListener("abort", abort);
      status.off("data", data);
      status.off("close", closed);
      resolve(ok);
    };
    const data = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 1024) return done(false);
      for (
        let newline = text.indexOf("\n");
        newline >= 0 && !settled;
        newline = text.indexOf("\n")
      ) {
        const line = text.slice(0, newline);
        text = text.slice(newline + 1);
        if (line === "prepared" && !sawPrepared && host.prepared) {
          sawPrepared = true;
          preparation = Promise.resolve()
            .then(() => host.prepared?.())
            .then(async () => {
              if (
                settled ||
                host.signal.aborted ||
                lifetime.signal.aborted ||
                child.exitCode !== null
              )
                return done(false);
              await host.dispatch?.();
              host.signal.throwIfAborted();
              dispatched = true;
              child.stdin?.write("go\n");
            })
            .catch((error: unknown) => {
              preparationFailed = true;
              preparationError = error;
              done(false);
            });
        } else if (line === "ready" && (!host.prepared || dispatched)) done(true);
        else done(false);
      }
    };
    const closed = () => done(false);
    const abort = () => done(false);
    const timeout = setTimeout(abort, HOST_READY_MS);
    status.on("data", data);
    status.once("close", closed);
    host.signal.addEventListener("abort", abort, { once: true });
    if (host.signal.aborted) abort();
    else child.stdin?.write(host.payload);
  });
  // The caller owns this validation even when startup times out; do not release its DB/lease early.
  if (!ready) {
    const drained = await Promise.allSettled([stop(), preparation]);
    // Cleanup must finish, but it must not replace a final authorization rejection.
    if (preparationFailed) throw preparationError;
    const failed = drained.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } else await preparation;
  return ready;
}
