import { AgentError } from "../core/errors.ts";

/** A slot belongs to actual work, not to a caller that merely stopped waiting. */
export function createPageExtractLimit(limit = 3) {
  let active = 0;
  const waiters: { signal: AbortSignal; ready(): void; abort(): void }[] = [];
  const release = () => {
    const next = waiters.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.ready();
    } else active--;
  };
  return async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (active < limit) active++;
    else {
      if (waiters.length >= 32) throw new AgentError("rate_limited");
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          signal,
          ready: resolve,
          abort() {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            signal.removeEventListener("abort", waiter.abort);
            reject(signal.reason);
          },
        };
        waiters.push(waiter);
        signal.addEventListener("abort", waiter.abort, { once: true });
        if (signal.aborted) waiter.abort();
      });
    }
    if (signal.aborted) {
      release();
      signal.throwIfAborted();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };
}
