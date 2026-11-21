import { HostSshError } from "./ssh-types.ts";

/** A slow user mount cannot hold preparation or a pending approval dispatch indefinitely. */
export async function hostSshSnapshot<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
): Promise<T> {
  parent.throwIfAborted();
  const deadline = new AbortController();
  const signal = AbortSignal.any([parent, deadline.signal]);
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  const timer = setTimeout(
    () => deadline.abort(new HostSshError("configuration_unavailable")),
    10_000,
  );
  try {
    // Node cannot interrupt every native FS operation. Its bounded operation still owns and
    // closes any late handle; this race never publishes that late recipe or starts a process.
    return await Promise.race([operation(signal), cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
